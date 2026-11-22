const { load } = require('cheerio');
const { meta } = require('../model');
const Provider = require('./provider');
const { getProxiedUrl } = require('./hls-proxy');

const pathMappings = {
  'Most Popular': '/most-popular/',
  'Top Rated': '/top-rated/',
};

class PorntrexProvider extends Provider {
  constructor() {
    super('https://www.porntrex.com', 'porntrex', 120);
  }

  static create() {
    return new PorntrexProvider();
  }

  getInitialUrl() {
    return new URL('/latest-updates/', this.baseUrl).toString();
  }

  handleSearch({ extra: { search: keyword } }) {
    return new URL(
      `/search/${encodeURIComponent(keyword)}/`,
      this.baseUrl,
    ).toString();
  }

  handleGenre({ extra: { genre } }) {
    if (
      typeof genre === 'string' &&
      (genre.startsWith('/') || /^[a-z][a-z\d+.-]*:\/\//i.test(genre))
    ) {
      return this.getGenreCatalogUrl(genre, pathMappings);
    }
    const path = pathMappings[genre] || `/categories/${this.toSlug(genre)}/`;
    return new URL(path, this.baseUrl).toString();
  }

  handlePagination(url, { extra: { skip } }) {
    const skipOffset = Number(skip);
    if (!Number.isFinite(skipOffset) || skipOffset <= 0) {
      return '';
    }
    const pageUrl = new URL(url);
    const pageSize =
      pageUrl.pathname.replace(/\/+$/, '') === '/latest-updates'
        ? 85
        : this.limit;
    const pageNumber = Math.floor(skipOffset / pageSize) + 1;
    pageUrl.pathname = `${pageUrl.pathname.replace(/\/+$/, '')}/${pageNumber}/`;
    return pageUrl.toString();
  }

  getCatalogMetas(html) {
    const metas = [];
    const $ = load(html);
    $('div.video-item').each((index, element) => {
      const $e = $(element);
      const $a = $e.children('a');
      const videoPageUrl = $a.attr('href');
      const $img = $a.children('img');
      const poster = $img.attr('data-src');
      const title = $img.attr('alt');
      metas.push(
        new meta.MetaPreview(
          new URL(videoPageUrl, this.baseUrl).toString(),
          Provider.TYPE,
          title,
          poster ? this.resolveUrl(poster) : undefined,
          { posterShape: 'landscape' },
        ),
      );
    });
    return metas;
  }

  parseVideoPage({ id, html }) {
    const regex = /var flashvars = (\{[^;]*\});/;
    let match = html.match(regex);
    if (match && match[1]) {
      const {
        video_title,
        video_categories,
        preview_url,
        video_url,
        video_url_text,
        video_alt_url5,
        video_alt_url4,
        video_alt_url3,
        video_alt_url2,
        video_alt_url,
        video_alt_url5_text,
        video_alt_url4_text,
        video_alt_url3_text,
        video_alt_url2_text,
        video_alt_url_text,
      } = JSON.parse(
        this.fixLooseJson(
          match[1].replace('var flashvars =', '').replace(';', '').trim(),
        ),
      );
      const categories = video_categories
        ? video_categories
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
        : [];
      const poster = this.resolveUrl(preview_url);
      const links = this.getMetaGenreLinks(
        'porntrex',
        categories.map((name) => ({
          name,
          href: new URL(
            `/categories/${this.toSlug(name)}/`,
            this.baseUrl,
          ).toString(),
        })),
      );
      const metaResponse = new meta.MetaResponse(
        id,
        Provider.TYPE,
        video_title,
        {
          genres: categories,
          genre: categories,
          poster: poster,
          background: poster,
          description: video_title,
          links,
        },
      );
      return {
        metaResponse,
        videoPageUrl: id,
        video_url,
        video_url_text,
        video_alt_url5,
        video_alt_url4,
        video_alt_url3,
        video_alt_url2,
        video_alt_url,
        video_alt_url5_text,
        video_alt_url4_text,
        video_alt_url3_text,
        video_alt_url2_text,
        video_alt_url_text,
      };
    }
    return {};
  }

  async processStreams({ id }) {
    return this.fetchHtml(id)
      .then((html) => this.parseVideoPage({ id, html }))
      .then((meta) => this.getStreams(meta));
  }

  async getStreams(meta) {
    if (meta) {
      const qualities = [
        'video_alt_url5',
        'video_alt_url4',
        'video_alt_url3',
        'video_alt_url2',
        'video_alt_url',
        'video_url',
      ];
      const pageUrl = meta.videoPageUrl || this.baseUrl;
      const requestHeaders = {
        Origin: new URL(pageUrl).origin,
        Referer: pageUrl,
      };
      const streams = await Promise.all(
        qualities
          .filter(
            (key) =>
              Object.prototype.hasOwnProperty.call(meta, key) && meta[key],
          )
          .map(async (key) => {
            const videoUrl = this.resolveUrl(meta[key]);
            return {
              url: await getProxiedUrl(videoUrl, requestHeaders),
              name: meta[`${key}_text`],
              type: Provider.TYPE,
            };
          }),
      );
      return { streams };
    }
    return { streams: [] };
  }

  resolveUrl(url) {
    if (!url) {
      return undefined;
    }
    if (url.startsWith('//')) {
      return `https:${url}`;
    }
    return new URL(url, this.baseUrl).toString();
  }

  fixLooseJson(looseJsonString) {
    let jsonString = looseJsonString.trim().replace(/^"(.*)"$/, '$1');
    jsonString = jsonString.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    jsonString = jsonString.replace(/'/g, '"');
    return jsonString;
  }
}

module.exports = PorntrexProvider.create;