require('dotenv').config();
const { load } = require('cheerio');
const { meta } = require('../model');
const Provider = require('./provider');

const sortByMappings = {
  'Most Recent': '/',
  'Weekly Top': '/SORT-top-weekly/',
  'Monthly Top': '/SORT-top-monthly/',
  'Most Viewed': '/SORT-most-viewed/',
  'Top Rated': '/SORT-top-rated/',
  'Longest': '/SORT-longest/',
};

class EpornerProvider extends Provider {
  constructor() {
    super('https://www.eporner.com', 'eporner', 60);
  }

  static create() {
    return new EpornerProvider();
  }

  getInitialUrl() {
    return this.baseUrl + '/cat/all/';
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/search/${encodeURIComponent(keyword)}/`;
  }

  handleGenre({ extra: { genre } }) {
    if (genre.includes('/cat')) {
      return `${this.baseUrl}${genre}`;
    }
    let [category, sortBy] = genre.split('(');
    category = category.toLowerCase().trim().replace(' ', '-').trim();
    sortBy = sortByMappings[sortBy.replace(')', '')];
    return `${this.baseUrl}/cat/${category}${sortBy}`;
  }

  handlePagination(url, { extra: { skip } }) {
    const prefix = url.endsWith('/') ? '' : '/';
    return `${prefix}${this.page(skip)}/`;
  }

  getCatalogMetas(html) {
    const metadataList = [];
    const $ = load(html);
    $('div.mb').each((_, element) => {
      const $e = $(element).children('.mbimg').first();
      const $a = $e.children('.mbcontent').children().first();
      const $img = $a.children('img').first();
      const poster = $img.attr('data-src') || $img.attr('src');
      const title = $img.attr('alt') || $a.attr('title');
      const videoPageUrl = $a.attr('href');
      if (videoPageUrl) {
        metadataList.push(
          new meta.MetaPreview(
            new URL(videoPageUrl, this.baseUrl).toString(),
            Provider.TYPE,
            title,
            poster,
            {
              posterShape: 'landscape',
            },
          ),
        );
      }
    });
    return metadataList;
  }

  parseVideoPage({ id, html }) {
    let regex = /EP.video.player.hash = '(.*)';/;
    let hash = html.match(regex);
    if (hash && hash[1]) {
      hash = hash[1];
    }
    const $ = load(html);
    const $metas = $('meta');
    let metaMap = {};
    $metas.each((i, e) => {
      const attribs = e.attribs;
      metaMap[attribs.name || attribs.property] = attribs.content;
    });
    const genreTags = $('.video-info-tags .vit-category')
      .map((_, category) => {
        const $category = $(category).children().first();
        return {
          name: $category.text().trim(),
          href: $category.attr('href'),
        };
      })
      .get()
      .filter(({ name, href }) => name && href);
    const links = this.getMetaGenreLinks('eporner', genreTags);
    regex = /EP.video.player.vid = '(.*)';/;
    let videoId = html.match(regex);
    if (videoId && videoId[1]) {
      videoId = videoId[1];
    }
    return new meta.MetaResponse(id, Provider.TYPE, metaMap['og:title'], {
      description: metaMap['og:description'],
      poster: metaMap['og:image'],
      background: metaMap['og:image'],
      genres: genreTags.map(({ name }) => name),
      genre: genreTags.map(({ name }) => name),
      links,
      extra: { hash, videoId },
    });
  }

  hash(a) {
    return (
      parseInt(a.substring(0, 8), 16).toString(36) +
      parseInt(a.substring(8, 16), 16).toString(36) +
      parseInt(a.substring(16, 24), 16).toString(36) +
      parseInt(a.substring(24, 32), 16).toString(36)
    );
  }

  async processStreams({ id }) {
    return this.fetchHtml(id)
      .then((html) => this.parseVideoPage({ id, html }))
      .then((meta) => this.getStreams(meta));
  }

  getStreams(meta) {
    const { hash, videoId } = meta.extra;
    const getVideoId = (id) => {
      const i = id.indexOf('video-') + 6;
      const j = id.indexOf('/', i);
      return id.substring(i, j);
    };
    const url = `https://www.eporner.com/xhr/video/${videoId || getVideoId(meta.id)}?hash=${this.hash(hash)}&domain=www.eporner.com&pixelRatio=2&playerWidth=0&playerHeight=0&fallback=false&embed=false&supportedFormats=hls,dash,h265,vp9,av1,mp4&_=1715117288633`;
    return this.fetchHtml(url).then((response) => {
      let data = response;
      if (typeof response === 'string') {
        try {
          data = JSON.parse(response);
        } catch (error) {
          throw new Error('Eporner playback endpoint returned invalid JSON', {
            cause: error,
          });
        }
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Eporner playback response must be an object');
      }
      if (!data.sources || typeof data.sources !== 'object') {
        throw new Error('Eporner playback response did not contain sources');
      }
      return this.selectSources(data.sources, meta.id);
    });
  }

  async selectSources(sources, referer = this.baseUrl) {
    const streams = [];
    const behaviorHints = {
      notWebReady: true,
      proxyHeaders: {
        request: {
          Origin: new URL(referer).origin,
          Referer: referer,
        },
      },
    };
    if (sources.mp4) {
      streams.push(
        ...Object.values(sources.mp4).map((mp4) => ({
          url: new URL(mp4.src, this.baseUrl).toString(),
          name: `${mp4.labelShort || 'Video'} MP4`,
          type: Provider.TYPE,
          behaviorHints,
        })),
      );
    }
    const hlsUrl = sources.hls && sources.hls.auto && sources.hls.auto.src;
    if (hlsUrl) {
      const hlsResponse = await super.getStreams({ videoPageUrl: hlsUrl });
      streams.push(
        ...hlsResponse.streams.map((stream) => ({
          ...stream,
          name: `${stream.name} HLS`,
          behaviorHints,
        })),
      );
      if (!hlsResponse.streams.length) {
        streams.push({
          type: Provider.TYPE,
          url: hlsUrl,
          name: 'HLS',
          behaviorHints,
        });
      }
    }
    return { streams };
  }

  transformStream(url, stream) {
    return { ...stream, url: new URL(stream.url, url).toString() };
  }
}

module.exports = EpornerProvider.create;