const { load } = require('cheerio');
const { meta } = require('../model');
const Provider = require('./provider');

const pathMappings = {
  'Amateur': '/c/Amateur-65',
  'Asian Woman': '/c/Asian_Woman-32',
  'Big Tits': '/c/Big_Tits-23',
  'Blonde': '/c/Blonde-20',
  'Blowjob': '/c/Blowjob-15',
  'Bus': '/?k=bus',
  'Creampie': '/c/Creampie-40',
  'Cuckold': '/c/Cuckold-237',
  'Gangbang': '/c/Gangbang-69',
  'Korea': '/?k=korea',
  'Lingerie': '/c/Lingerie-83',
  'Oiled': '/c/Oiled-22',
  'Teen': '/c/Teen-13',
};

class XvideosProvider extends Provider {
  constructor() {
    super('https://www.xvideos.com', 'xvideos', 48);
  }

  static create() {
    return new XvideosProvider();
  }

  getInitialUrl() {
    return this.baseUrl + '/change-country/vn';
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/?k=${encodeURIComponent(keyword)}`;
  }

  handleGenre({ extra: { genre } }) {
    return this.getGenreCatalogUrl(genre, pathMappings);
  }

  handlePagination(url, { extra: { skip } }) {
    const pageUrl = new URL(url);
    const skipOffset = Number(skip);
    const isHomepage =
      !pageUrl.pathname.startsWith('/c/') && !pageUrl.searchParams.has('k');
    const page = isHomepage
      ? Math.ceil(Math.max(0, skipOffset - this.limit) / 25) + 1
      : Math.ceil(skipOffset / 25);
    if (pageUrl.pathname === '/change-country/vn') {
      pageUrl.pathname = '/';
    }
    if (pageUrl.pathname.startsWith('/c/')) {
      pageUrl.pathname = `${pageUrl.pathname.replace(/\/+$/, '')}/${page}`;
    } else if (pageUrl.pathname === '/' && !pageUrl.searchParams.has('k')) {
      pageUrl.pathname = `/new/${page}`;
    } else {
      pageUrl.searchParams.set('p', page);
    }
    return pageUrl.toString();
  }

  getCatalogMetas(html) {
    const metadatas = [];
    const $ = load(html);
    $('div.frame-block.thumb-block').each((_, element) => {
      const $div = $(element);
      const $thumbInside = $div.children('.thumb-inside').first();
      const $thumbUnder = $div.children('.thumb-under').first();
      if (!$thumbInside.length || !$thumbUnder.length) {
        return;
      }
      const $videoLink = $thumbInside.find('a[href]').first();
      const $image = $thumbInside.find('img[data-src]').first();
      let href = $videoLink.attr('href');
      let posterUrl = $image.attr('data-src');
      const title = $thumbUnder.find('p > a[title]').first().attr('title');
      if (!href || !posterUrl || !title) {
        return;
      }
      if (/THUMBNUM/i.test(href) || /THUMBNUM/i.test(posterUrl)) {
        const idcdn = $image.attr('data-idcdn');
        if (!idcdn) {
          return;
        }
        href = href.replace(/THUMBNUM/gi, idcdn);
        posterUrl = posterUrl.replace(/THUMBNUM/gi, idcdn);
      }
      const videoPageUrl = new URL(href, this.baseUrl).toString();
      const poster = new URL(posterUrl, this.baseUrl).toString();
      if (videoPageUrl) {
        metadatas.push(
          new meta.MetaPreview(videoPageUrl, Provider.TYPE, title, poster, {
            posterShape: 'landscape',
          }),
        );
      }
    });
    return metadatas;
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
    const regexVideoHLS = /html5player\.setVideoHLS\('(.*)'\);/;
    const regexThumbnail = /html5player\.setThumbUrl169\('(.*)'\);/;
    let videoPageUrl = '';
    let background = '';
    let match = html.match(regexVideoHLS);
    if (match && match[1]) {
      videoPageUrl = match[1];
    }
    match = html.match(regexThumbnail);
    if (match && match[1]) {
      background = match[1];
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
    return this.fetchHtml(id).then(async (html) => {
      const videoPage = await this.parseVideoPage({ id, html });
      let streamsResponse = await super.getStreams(videoPage);
      if (streamsResponse && streamsResponse.streams.length > 0) {
        return streamsResponse;
      }
      const $ = load(html);
      const $json = JSON.parse($('script[type="application/ld+json"]').text());
      const streams = [
        {
          type: 'movie',
          url: $json['contentUrl'],
          name: 'OnlyAVideo',
        },
      ];
      return { streams };
    });
  }

  transformStream(url, stream) {
    return { ...stream, url: url.replace('hls.m3u8', '') + stream.url };
  }
}

module.exports = XvideosProvider.create;