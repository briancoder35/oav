const { load } = require('cheerio');
const { meta } = require('../model');
const Provider = require('./provider');

const DEFAULT_POSTER = 'https://thumb-cdn77.xvideos-cdn.com/default.jpg';

const cleanTitle = (title = '') =>
  title
    .replace(/^xvideos\s*video\s*/i, '')
    .replace(/^xvideos\s*/i, '')
    .trim();

const normalizeUrl = (url) => {
  if (!url || typeof url !== 'string') return undefined;

  if (!url.includes('xvideos-cdn.com')) return url;

  if (url.includes('thumb-cdn77')) return url;

  return url
    .replace(/^\/\//, 'https://')
    .replace(/thumbs?-cdn\d+\.xvideos-cdn\.com/, 'thumb-cdn77.xvideos-cdn.com')
    .replace(/thumbs\d*\.xvideos-cdn\.com/, 'thumb-cdn77.xvideos-cdn.com');
};

const htmlCache = new Map();

const inFlight = new Map();
const HTML_TTL = 1000 * 60 * 5;

const metaCache = new Map();
const META_TTL = 1000 * 60 * 5;

class XvideosProvider extends Provider {
  constructor() {
    super('https://www.xvideos.com', 'xvideos', 50);
  }

  static create() {
    return new XvideosProvider();
  }

  async fetchHtml(url) {
    const cached = htmlCache.get(url);

    if (cached && Date.now() - cached.time < HTML_TTL) {
      return cached.data;
    }

    if (inFlight.has(url)) {
      return inFlight.get(url);
    }

    const promise = (async () => {
      try {
        const html = await super.fetchHtml(url);

        htmlCache.set(url, { data: html, time: Date.now() });
        if (htmlCache.size > 300) {
          htmlCache.delete(htmlCache.keys().next().value);
        }

        return html;
      } finally {
        inFlight.delete(url);
      }
    })();
    inFlight.set(url, promise);

    return promise;
  }

  getInitialUrl() {
    return this.baseUrl;
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/?k=${encodeURIComponent(keyword)}`;
  }

  handleGenre(args) {
    const genre = args.extra.genre;
    if (
      typeof genre === 'string' &&
      (genre.startsWith('/') || /^https?:\/\//i.test(genre))
    ) {
      return this.getGenreCatalogUrl(genre, {});
    }
    return this.handleSearch({ ...args, extra: { search: args.extra.genre } });
  }

  handlePagination(url, { extra: { skip, search } }) {
    if (search) {
      this.limit = 25;
    }
    const prefix = url.includes('?') ? '&' : '?';
    return `${prefix}p=${this.page(skip)}`;
  }

  getCatalogMetas(html) {
    const metadatas = [];
    const $ = load(html);
    const seen = new Set();

    $('div.frame-block.thumb-block').each((_, element) => {
      const $div = $(element);
      const $thumbInside = $div.children('.thumb-inside').first();
      const $thumbUnder = $div.children('.thumb-under').first();
      if (!$thumbInside.length || !$thumbUnder.length) {
        return;
      }

      const $videoLink = $thumbInside
        .find('a[href]')
        //.filter((_, anchor) => !/THUMBNUM/i.test($(anchor).attr('href')))
        .first();
      const href = $videoLink
        .attr('href')
        .split('?')[0]
        .replace(/\/THUMBNUM.*/, '')
        .replace(/\/$/, '');

      if (seen.has(href)) return;

      seen.add(href);
      const videoPageUrl = new URL(href, this.baseUrl).toString();
      const title = $thumbUnder.find('p > a[title]').first().attr('title');
      const img = $div.find('img').first();
      let thumb =
        img.attr('data-thumb_url169') ||
        img.attr('data-thumb_url') ||
        img.attr('data-thumb') ||
        img.attr('data-src') ||
        img.attr('src');
      thumb = normalizeUrl(thumb);

      if (!thumb) {
        thumb = DEFAULT_POSTER;
      } else if (thumb.includes('THUMBNUM')) {
        const candidates = [
          img.attr('data-thumb'),
          img.attr('data-src'),
          img.attr('src'),
        ].filter(Boolean);
        let resolved = null;

        for (const c of candidates) {
          const match = c.match(/xv_(\d+)_t\.jpg/);
          if (match) {
            resolved = thumb.replace('THUMBNUM', match[1]);
            break;
          }
        }
        if (!resolved) {
          resolved = thumb.replace('THUMBNUM', '15');
        }

        thumb = normalizeUrl(resolved);

        if (!thumb) {
          thumb = DEFAULT_POSTER;
        }
      }
      //const poster = new URL(posterUrl, this.baseUrl).toString();

      if (videoPageUrl) {
        metadatas.push(
          new meta.MetaPreview(
            videoPageUrl,
            Provider.TYPE,
            cleanTitle(title),
            thumb,
            { posterShape: 'landscape' },
          ),
        );
      }
    });
    return metadatas;
  }

  async getMetadata(args) {
    const cached = metaCache.get(args.id);
    if (cached && Date.now() - cached.time < META_TTL) {
      return cached.data.metaResponse;
    }

    const html = await this.fetchHtml(args.id);
    const parsed = this.parseVideoPage({ id: args.id, html });

    metaCache.set(args.id, {
      data: parsed,
      time: Date.now(),
    });

    if (metaCache.size > 300) {
      const firstKey = metaCache.keys().next().value;
      metaCache.delete(firstKey);
    }

    return parsed.metaResponse;
  }

  parseVideoPage({ id, html }) {
    const $ = load(html);
    const tagElements = $(
      '.video-metadata.video-tags-list.ordered-label-list.cropped a.is-keyword.btn.btn-default',
    )
      .map((_, element) => ({
        name: $(element).text().trim(),
        href: $(element).attr('href'),
      }))
      .get()
      .filter(({ name, href }) => name && href);
    const genres = tagElements.map(({ name }) => name);
    const links = this.getMetaGenreLinks(
      'xvideos',
      tagElements.map(({ name, href }) => ({
        name,
        href: new URL(href, this.baseUrl).toString(),
      })),
    );

    $('script').each((i, e) => {
      const $script = $(e);
      if ($script.text().includes('html5player')) {
        // console.log("html5player", JSON.stringify($script.text()));
      }
    });

    const regexVideoHLS = /html5player\.setVideoHLS\('(.*)'\);/;
    const regexThumbnail = /html5player\.setThumbUrl169\('(.*)'\);/;
    let videoPageUrl = '';
    let background = '';

    let match = html.match(regexVideoHLS);
    if (match && match[1]) {
      videoPageUrl = match[1]; // Extracted URL from the capture group
    }

    match = html.match(regexThumbnail);
    if (match && match[1]) {
      background = match[1]; // Extracted URL from the capture group
    }

    const $metas = $('meta');
    let metaMap = {};
    $metas.each((i, e) => {
      const attribs = e.attribs;
      metaMap[attribs.name || attribs.property] = attribs.content;
    });
    const metaResponse = new meta.MetaResponse(
      id,
      Provider.TYPE,
      metaMap['og:title'],
      {
        links,
        description: metaMap['description'],
        background: background,
        poster: background,
        posterShape: 'landscape',
        genres: genres,
        genre: genres,
      },
    );
    return {
      metaResponse,
      videoPageUrl,
    };
  }

  async processStreams({ id }) {
    let cached = metaCache.get(id);
    let metaData;

    if (cached && Date.now() - cached.time < META_TTL) {
      metaData = cached.data;
    } else {
      const html = await this.fetchHtml(id);
      metaData = this.parseVideoPage({ id, html });

      metaCache.set(id, {
        data: metaData,
        time: Date.now(),
      });
    }

    let streamsResponse = await super.getStreams(metaData);

    if (streamsResponse?.streams?.length) {
      streamsResponse.streams = streamsResponse.streams.map((s) => {
        const match = s.url?.match(/(\d{3,4})p/);
        const resolution =
          s.resolution || (match ? match[1] + 'p' : null) || 'unknown';
        let finalUrl = s.url;

        if (!s.url.startsWith('http') && metaData.videoPageUrl) {
          const base = metaData.videoPageUrl.substring(
            0,
            metaData.videoPageUrl.lastIndexOf('/') + 1,
          );
          finalUrl = base + s.url;
        }

        return {
          ...s,
          url: finalUrl,
          name: `XVideos ${resolution}`,
          quality: resolution,
        };
      });

      streamsResponse.streams.sort((a, b) => {
        const getNum = (r) => parseInt(r) || 0;
        return getNum(b.quality) - getNum(a.quality);
      });

      return streamsResponse;
    }

    const $ = load(await this.fetchHtml(id));
    let contentUrl;
    try {
      contentUrl = JSON.parse(
        $('script[type="application/ld+json"]').first().text(),
      )?.contentUrl;
    } catch {
      return { streams: [] };
    }
    if (typeof contentUrl !== 'string' || !contentUrl) {
      return { streams: [] };
    }
    const streams = [
      {
        type: Provider.TYPE,
        url: contentUrl,
        name: 'OnlyAVideo',
      },
    ];
    return { streams };
  }

  transformStream(url, stream) {
    return {
      ...stream,
      url: url.includes('hls.m3u8')
        ? url.replace('hls.m3u8', '') + stream.url
        : url + stream.url,
    };
  }
}

module.exports = XvideosProvider.create;
