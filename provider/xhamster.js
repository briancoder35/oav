const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');

const metaCache = new Map();
const META_TTL = 1000 * 60 * 10;

const htmlCache = new Map();
const inFlight = new Map();
const HTML_TTL = 1000 * 60 * 5;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(instance, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await instance(url);
    } catch (err) {
      if (err.response?.status === 429) {
        logger.debug(`429 retry (${i + 1})`);
        await delay(2000 * (i + 1));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Max retries reached');
}

const pathMappings = {
  'Best (Daily)': '/best',
  'Best (Weekly)': '/best/weekly',
  'Best (Monthly)': '/best/monthly',
};

function normalizeGenreUrl(url) {
  if (typeof url !== 'string') {
    return url;
  }
  return url.replace(/\\\//g, '/').replace(/^(https?):\/(?!\/)/i, '$1://');
}

function parseInitials(script) {
  const assignment = script.match(/window\.initials\s*=\s*/);
  if (!assignment) {
    throw new Error('xHamster initials script was not found');
  }

  const jsonText = script
    .slice(assignment.index + assignment[0].length)
    .trim()
    .replace(/;\s*$/, '');
  return JSON.parse(jsonText);
}

class XhamsterProvider extends Provider {
  constructor() {
    super('https://xhamster.com', 'xhamster', 40);
  }

  static create() {
    return new XhamsterProvider();
  }

  toSlug(str) {
    return str
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/&/g, '')
      .replace(/[^a-z0-9-]/g, '');
  }

  getMode(catalogId = '') {
    const id = catalogId.toLowerCase();

    if (id.includes('best')) return 'best';

    return '';
  }

  getInitialUrl(catalogId) {
    const mode = this.getMode(catalogId);

    return mode ? `${this.baseUrl}/${mode}` : this.baseUrl;
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/search/${encodeURIComponent(keyword)}/`;
  }

  handleGenre({ id, extra: { genre } }) {
    const mode = this.getMode(id);
    const slug = this.toSlug(genre);

    if (slug === '4k') {
      return mode ? `${this.baseUrl}/4k/${mode}` : `${this.baseUrl}/4k`;
    }

    if (pathMappings[genre]) {
      return this.baseUrl + pathMappings[genre];
    }

    if (!mode) {
      return `${this.baseUrl}/categories/${slug}`;
    }

    return `${this.baseUrl}/categories/${slug}/${mode}`;
  }

  handlePagination(url, { extra: { skip } }) {
    const page = this.page(skip);
    if (!page || page === '1') return url.replace(/\/1\/?$/, '/');

    const base = url.replace(/\/$/, '').replace(/\/\d+$/, '');
    return `${base}/${page}/`;
  }

  async fetchHtml(url) {
    if (inFlight.has(url)) return inFlight.get(url);

    const promise = (async () => {
      const cached = htmlCache.get(url);
      if (cached && Date.now() - cached.time < HTML_TTL) {
        return cached.data;
      }

      const html = await fetchWithRetry(
        (u) =>
          super.fetchHtml(u, {
            headers: {
              'User-Agent': 'Mozilla/5.0',
              Accept: 'text/html',
              Referer: 'https://xhamster.com/',
              Cookie:
                'x_content_preference_index=straight; parental-control=yes',
            },
          }),
        url,
      );
      htmlCache.set(url, { data: html, time: Date.now() });

      return html;
    })();
    inFlight.set(url, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(url);
    }
  }

  getCatalogMetas(html) {
    const metadatas = [];
    const $ = load(html);
    const seen = new Set();
    const json = parseInitials($('#initials-script').text());
    const videoThumbProps =
      json.layoutPage &&
      json.layoutPage.videoListProps &&
      json.layoutPage.videoListProps.videoThumbProps;

    if (!Array.isArray(videoThumbProps)) {
      return metadatas;
    }

    videoThumbProps
      .filter(
        (video) => video && typeof video.pageURL === 'string' && video.pageURL,
      )
      .map((video) => {
        const videoPageUrl = new URL(video.pageURL, this.baseUrl).toString();

        if (seen.has(videoPageUrl)) return;

        let poster = video.thumbURL || video.imageURL;

        if (poster && !poster.startsWith('http')) {
          poster = this.baseUrl + poster;
        }

        metadatas.push(
          new meta.MetaPreview(
            videoPageUrl,
            Provider.TYPE,
            video.title,
            poster,
            { posterShape: 'landscape' },
          ),
        );
        seen.add(videoPageUrl);
      });

    return metadatas;
  }

  async getMetadata(args) {
    let id = args.id;

    if (!id.startsWith('http')) id = this.baseUrl + id;

    const cached = metaCache.get(id);

    if (cached && Date.now() - cached.time < META_TTL) return cached.data;

    const html = await this.fetchHtml(id);
    const data = this.parseVideoPage({ id, html });

    metaCache.set(id, { data, time: Date.now() });
    return data;
  }

  parseVideoPage({ id, html }) {
    const $ = load(html);
    const json = parseInitials($('#initials-script').text());
    const videoPageUrl = $('link[rel="preload"][as="fetch"][href*=".m3u8"]')
      .first()
      .attr('href');
    if (!videoPageUrl) {
      throw new Error(
        'xHamster HLS playlist URL was not found in preload links',
      );
    }

    const videoModel = json.videoModel || {};
    const videoEntity = json.videoEntity || {};
    const genreTags = (
      json.videoTagsComponent && Array.isArray(json.videoTagsComponent.tags)
        ? json.videoTagsComponent.tags
        : []
    ).filter(
      (tag) =>
        tag &&
        tag.isCategory === true &&
        typeof tag.nameEn === 'string' &&
        tag.nameEn.trim(),
    );
    const genres = genreTags.map((tag) => tag.nameEn.trim());
    const links = this.getMetaGenreLinks(
      'xhamster',
      genreTags.map((tag) => ({
        name: tag.nameEn.trim(),
        href: normalizeGenreUrl(tag.url),
      })),
    );
    const response = new meta.MetaResponse(
      id,
      Provider.TYPE,
      videoEntity.title || videoModel.title || '',
      {
        videoPageUrl: new URL(videoPageUrl, id).toString(),
        description:
          videoModel.description || videoModel.title || videoEntity.title,
        poster: videoModel.thumbURL,
        background: videoModel.thumbURL,
        posterShape: 'landscape',
        genres: genres,
        genre: genres,
        links,
      },
    );

    return response;
  }

  transformStream(url, stream) {
    return {
      ...stream,
      url,
      headers: {
        Referer: 'https://xhamster.com/',
        Origin: 'https://xhamster.com',
        'User-Agent': 'Mozilla/5.0',
      },
    };
  }
}

module.exports = XhamsterProvider.create;
