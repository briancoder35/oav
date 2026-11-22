const { Buffer } = require('node:buffer');
const { load } = require('cheerio');
const { meta } = require('../model');
const { getProxiedUrl } = require('./hls-proxy');
const Provider = require('./provider');

const pathMappings = {
  'New release': '/category/jav/?orderby=date&order=DESC',
  'Popular Month': '/category/jav/?orderby=views-monthly&order=DESC',
};

function getJsString(source, key) {
  const match = source.match(new RegExp(`\\b${key}\\s*:\\s*(['"])(.*?)\\1`));
  return match?.[2];
}

function parseWindowConfig(html) {
  const source = html.match(/\bwindow\.cfg\s*=\s*\{([\s\S]*?)\}\s*;/)?.[1];
  if (!source) {
    return undefined;
  }
  const keysMatch = source.match(/\bkeys\s*:\s*\[([\s\S]*?)\]/);
  const config = {
    cid: getJsString(source, 'cid'),
    base: getJsString(source, 'base'),
    rtype: getJsString(source, 'rtype'),
    cls: getJsString(source, 'cls'),
    keys: keysMatch
      ? [...keysMatch[1].matchAll(/(['"])(.*?)\1/g)].map((match) => match[2])
      : undefined,
  };
  return Object.values(config).some((value) => value === undefined) ||
    !config.keys?.length
    ? undefined
    : config;
}

function unpackPlayer(html) {
  const match = html.match(
    /\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([^']*)'\.split\('\|'\)\)\)/,
  );
  if (!match) {
    return undefined;
  }
  const [, packedCode, radixValue, wordCountValue, dictionary] = match;
  const radix = Number(radixValue);
  const wordCount = Number(wordCountValue);
  const words = dictionary.split('|');
  if (!Number.isInteger(radix) || radix < 2 || radix > 36) {
    return undefined;
  }
  let unpackedCode = packedCode;
  for (
    let index = Math.min(wordCount, words.length) - 1;
    index >= 0;
    index -= 1
  ) {
    const token = index.toString(radix);
    if (words[index]) {
      unpackedCode = unpackedCode.replace(
        new RegExp(`(^|[^A-Za-z0-9_$])${token}([^A-Za-z0-9_$]|$)`, 'gi'),
        (_match, leading, trailing) => `${leading}${words[index]}${trailing}`,
      );
    }
  }
  return unpackedCode;
}

function parsePackedPlayerFileUrl(html) {
  const unpackedCode = unpackPlayer(html);
  if (!unpackedCode) {
    return undefined;
  }
  const linksMatch = unpackedCode.match(
    /\b(?:var\s+)?links\s*=\s*\{([\s\S]*?)\}\s*;/,
  );
  if (linksMatch) {
    const hls2Match = linksMatch[1].match(
      /["']hls2["']\s*:\s*("(?:\\.|[^"\\])*")/i,
    );
    if (hls2Match) {
      try {
        const hls2Url = JSON.parse(hls2Match[1]);
        if (/\.m3u8(?:$|[?#])/i.test(hls2Url)) {
          return hls2Url;
        }
      } catch {
        // Try other URL patterns below.
      }
    }
  }
  const hls2Match = unpackedCode.match(
    /["']hls2["']\s*:\s*("(?:\\.|[^"\\])*"|\/[^"'<>\\s]+)/i,
  );
  if (hls2Match) {
    const hls2Url = hls2Match[1].replace(/^["']|["']$/g, '');
    if (hls2Url.startsWith('/')) {
      return `https://javclan.com${hls2Url}`;
    }
    if (/\.m3u8(?:$|[?#])/i.test(hls2Url)) {
      return hls2Url;
    }
  }
  const javclanMatch = unpackedCode.match(
    /(https?:\/\/javclan\.com\/[^\s"'<>]+\.m3u8[^\s"'<>]*|\/stream\/[^\s"'<>]+\/master\.m3u8)/i,
  );
  if (javclanMatch) {
    return javclanMatch[1].startsWith('/')
      ? `https://javclan.com${javclanMatch[1]}`
      : javclanMatch[1];
  }
  const fileMatch = unpackedCode.match(
    /\b(?:file|url)\s*[:=]\s*("(?:\\.|[^"\\])*"|`[^`]*`)/,
  );
  if (fileMatch) {
    const rawUrl = fileMatch[1].replace(/^["'`]|["'`]$/g, '');
    if (/\.m3u8(?:$|[?#])/i.test(rawUrl)) {
      return rawUrl;
    }
  }
  return undefined;
}

class JavguruProvider extends Provider {
  constructor() {
    super('https://jav.guru', 'javguru', 24);
  }

  static create() {
    return new JavguruProvider();
  }

  activate(id) {
    if (typeof id !== 'string') {
      return false;
    }
    if (super.activate(id)) {
      return true;
    }
    try {
      return new URL(id).hostname === new URL(this.baseUrl).hostname;
    } catch {
      return false;
    }
  }

  getInitialUrl() {
    return this.baseUrl;
  }

  handleSearch({ extra: { search } }) {
    const searchUrl = new URL('/', this.baseUrl);
    searchUrl.searchParams.set('s', String(search).trim());
    return searchUrl.toString();
  }

  handleGenre({ extra: { genre } }) {
    if (
      typeof genre === 'string' &&
      (genre.startsWith('/') || /^[a-z][a-z\d+.-]*:\/\//i.test(genre))
    ) {
      return this.getGenreCatalogUrl(genre, pathMappings);
    }
    const path = pathMappings[genre] || `/category/${this.toSlug(genre)}/`;
    return new URL(path, this.baseUrl).toString();
  }

  handlePagination(url, { extra: { skip } }) {
    const skipOffset = Number(skip);
    if (!Number.isFinite(skipOffset) || skipOffset <= 0) {
      return '';
    }
    const pageNumber = Math.floor(skipOffset / this.limit) + 1;
    const pageUrl = new URL(url);
    if (pageUrl.searchParams.has('s')) {
      pageUrl.pathname = `/page/${pageNumber}/`;
      return pageUrl.toString();
    }
    const cleanPath = pageUrl.pathname
      .replace(/\/(?:page\/\d+)\/?$/, '')
      .replace(/\/+$/, '');
    pageUrl.pathname = `${cleanPath}/page/${pageNumber}/`;
    if (!pageUrl.searchParams.has('orderby')) {
      pageUrl.search = '';
    }
    return pageUrl.toString();
  }

  async getCatalogMetas(html) {
    const $ = load(html);
    const metadatas = [];
    for (const element of $('.inside-article').toArray()) {
      const $article = $(element);
      const $link = $article.find('.imgg a[href]').first();
      const $image = $link.find('img[src]').first();
      if (!$link.length || !$image.length) {
        continue;
      }
      const videoPageUrl = new URL($link.attr('href'), this.baseUrl).toString();
      let poster = $image.attr('src')
        ? new URL($image.attr('src'), this.baseUrl).toString()
        : undefined;
      if (poster) {
        poster = await getProxiedUrl(poster, {
          Origin: this.baseUrl,
          Referer: `${this.baseUrl}/`,
        });
      }
      metadatas.push(
        new meta.MetaPreview(
          videoPageUrl,
          Provider.TYPE,
          $image.attr('alt')?.trim(),
          poster,
          { posterShape: 'landscape' },
        ),
      );
    }
    return metadatas;
  }

  async parseVideoPage({ id, html }) {
    const $ = load(html);
    const metaMap = {};
    $('meta').each((_, element) => {
      const { name, property, content } = element.attribs;
      metaMap[name || property] = content;
    });

    const title =
      $('h1.titl').first().text().trim() ||
      metaMap['og:title'] ||
      $('title').first().text().trim();
    const posterElement = $('.large-screenimg img[src]').first();
    const posterUrl = posterElement.attr('src')?.trim() || metaMap['og:image'];
    let poster = posterUrl ? new URL(posterUrl, id).toString() : undefined;
    if (poster) {
      poster = await getProxiedUrl(poster, {
        Origin: this.baseUrl,
        Referer: id,
      });
    }
    const tagElements = $('li.w1')
      .filter(
        (_, element) =>
          $(element)
            .find('strong')
            .first()
            .text()
            .trim()
            .replace(/:\s*$/, '')
            .toLowerCase() === 'tags',
      )
      .find('a[rel="tag"]')
      .map((_, element) => ({
        name: $(element).text().trim(),
        href: $(element).attr('href'),
      }))
      .get()
      .filter(({ name, href }) => name && href);
    const iframeElement = $('#wp-btn-iframe')
      .filter((_, element) => $(element).text().trim() === 'STREAM SB')
      .first();
    const localize = iframeElement.attr('data-localize');
    if (!localize) {
      throw new Error('Javguru STREAM SB data-localize was not found');
    }
    const scriptText = $('#wp-btn-iframe-js-extra').text();
    const configMatch = scriptText.match(
      new RegExp(`\\bvar\\s+${localize}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`),
    );
    const localizedConfig = configMatch
      ? JSON.parse(configMatch[1])
      : undefined;
    const iframeUrl = localizedConfig?.iframe_url
      ? new URL(
          Buffer.from(localizedConfig.iframe_url, 'base64').toString('utf8'),
          id,
        ).toString()
      : undefined;
    if (!iframeUrl) {
      throw new Error('Javguru STREAM SB iframeUrl was not found');
    }
    const iframeHtml = await this.fetchHtml(iframeUrl, {
      referer: id,
      redirectReferer: `${this.baseUrl}/`,
    });
    const iframeConfig = parseWindowConfig(iframeHtml);
    if (!iframeConfig) {
      throw new Error('Javguru iframePageConfig was not found');
    }
    const $iframePage = load(iframeHtml);
    const container = $iframePage(`[id="${iframeConfig.cid}"]`).first();
    const tokenParts = iframeConfig.keys.map((key) => container.attr(key));
    if (tokenParts.some((part) => !part)) {
      throw new Error('Javguru realSrc token was not found');
    }
    const token = tokenParts.join('').split('').reverse().join('');
    const videoPageUrl = `${iframeConfig.base}?${iframeConfig.rtype}r=${token}`;
    const playerHtml = await this.fetchHtml(videoPageUrl, {
      referer: iframeUrl,
      redirectReferer: `${this.baseUrl}/`,
    });
    const m3u8Url = parsePackedPlayerFileUrl(playerHtml);
    if (!m3u8Url) {
      throw new Error('Javguru HLS playlist URL was not found');
    }
    const genres = tagElements.map(({ name }) => name);
    const metaResponse = new meta.MetaResponse(id, Provider.TYPE, title, {
      description:
        posterElement.attr('alt')?.trim() || metaMap['og:description'] || title,
      poster,
      background: poster,
      genres,
      genre: genres,
      links: this.getMetaGenreLinks('javguru', tagElements),
      videoPageUrl: m3u8Url,
    });
    return {
      metaResponse,
      videoPageUrl: m3u8Url,
      videoSources: [
        {
          url: new URL(m3u8Url, videoPageUrl).toString(),
          type: 'application/vnd.apple.mpegurl',
          name: 'STREAM SB',
        },
      ],
    };
  }

  async processStreams({ id }) {
    const html = await this.fetchHtml(id);
    const videoPage = await this.parseVideoPage({ id, html });
    const hlsSource = videoPage.videoSources.find(
      (source) =>
        /\.m3u8(?:$|[?#])/i.test(source.url) || /mpegurl/i.test(source.type),
    );
    if (!hlsSource) {
      return super.getStreams(videoPage);
    }
    const streamUrl = await getProxiedUrl(hlsSource.url, {
      Referer: hlsSource.url,
    });
    return {
      streams: [
        {
          type: Provider.TYPE,
          url: streamUrl,
          name: 'STREAM SB',
        },
      ],
    };
  }

  transformStream(url, stream) {
    return { ...stream, url: new URL(stream.url, url).toString() };
  }
}

module.exports = JavguruProvider.create;
module.exports.normalizeM3u8Url = (url) =>
  url.replace(/^ttps:\/\//i, 'https://');
module.exports.parsePackedPlayerFileUrl = parsePackedPlayerFileUrl;