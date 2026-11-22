const { load } = require('cheerio');
const { meta } = require('../model');
const Provider = require('./provider');

const pathMappings = {
  'Best (Daily)': '/best/daily',
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
    return null;
  }
  const jsonText = script
    .slice(assignment.index + assignment[0].length)
    .trim()
    .replace(/;\s*$/, '');
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

class XhamsterProvider extends Provider {
  constructor() {
    super('https://xhamster.com', 'xhamster', 45);
  }

  static create() {
    return new XhamsterProvider();
  }

  getInitialUrl(catalogId) {
    let url = this.baseUrl;
    if (catalogId.toLowerCase().includes('.4k')) {
      url += '/4k';
    }
    return `${url}/newest/?geo=vn`;
  }

  handleSearch({ id, extra: { search: keyword } }) {
    const searchText = encodeURIComponent(String(keyword).trim()).replace(
      /%20/g,
      '+',
    );
    const searchUrl = new URL(`/search/${searchText}`, this.baseUrl);
    if (id && id.toLowerCase().includes('.4k')) {
      searchUrl.searchParams.set('quality', '2160p');
    }
    return searchUrl.toString();
  }

  handleGenre({ id, extra: { genre } }) {
    const mappedPath = pathMappings[genre];
    const qualityPath = id.toLowerCase().includes('.4k') ? '/4k' : '';
    if (mappedPath) {
      return new URL(qualityPath + mappedPath, this.baseUrl).toString();
    }
    const slug = this.toSlug(genre);
    return new URL(
      `/categories/${slug}${qualityPath}`,
      this.baseUrl,
    ).toString();
  }

  handlePagination(url, { extra: { skip } }) {
    const pageUrl = new URL(url);
    const skipOffset = Number(skip);
    if (!Number.isFinite(skipOffset) || skipOffset <= 0) {
      return '';
    }
    const pageNumber = Math.floor(skipOffset / this.limit) + 1;
    if (pageUrl.pathname.includes('/search/')) {
      pageUrl.pathname = pageUrl.pathname.replace(/\/+$/, '');
      pageUrl.searchParams.set('page', pageNumber);
    } else {
      pageUrl.search = '';
      pageUrl.pathname = `${pageUrl.pathname.replace(/\/+$/, '')}/${pageNumber}`;
    }
    return pageUrl.toString();
  }

  getCatalogMetas(html) {
    const metadatas = [];
    const $ = load(html);
    const json = parseInitials($('#initials-script').text());
    if (!json) {
      return metadatas;
    }
    const videoThumbProps = [
      json.layoutPage?.videoListProps?.videoThumbProps,
      json.pagesCategoryComponent?.trendingVideoListProps?.videoThumbProps,
      json.searchResult?.videoThumbProps,
    ].find(Array.isArray);
    if (!Array.isArray(videoThumbProps)) {
      return metadatas;
    }
    videoThumbProps
      .filter(
        (video) => video && typeof video.pageURL === 'string' && video.pageURL,
      )
      .map((video) => {
        const videoPageUrl = new URL(video.pageURL, this.baseUrl).toString();
        metadatas.push(
          new meta.MetaPreview(
            videoPageUrl,
            Provider.TYPE,
            video.title,
            video.imageURL,
            { posterShape: 'landscape' },
          ),
        );
      });
    return metadatas;
  }

  async getMetadata(args) {
    const { id } = args;
    return this.fetchHtml(id).then((html) => this.parseVideoPage({ id, html }));
  }

  parseVideoPage({ id, html }) {
    const $ = load(html);
    const json = parseInitials($('#initials-script').text()) || {};
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
      'xhamster.hd',
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
        genres: genres,
        genre: genres,
        links,
      },
    );
    return response;
  }

  transformStream(url, stream) {
    return { ...stream, url: new URL(stream.url, url).toString() };
  }
}

module.exports = XhamsterProvider.create;