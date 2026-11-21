const { load } = require('cheerio');
const { meta } = require('../model');
const Provider = require('./provider');
const { Buffer } = require('node:buffer');
const { getProxiedUrl } = require('./hls-proxy');

function getJsString(source, key) {
  const match = source.match(new RegExp(`\\b${key}\\s*:\\s*(['"])(.*?)\\1`));
  return match ? match[2] : undefined;
}

function parseWindowConfig(html) {
  const configMatch = html.match(/\bwindow\.cfg\s*=\s*\{([\s\S]*?)\}\s*;/);
  if (!configMatch) {
    return undefined;
  }

  const source = configMatch[1];
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

  if (
    Object.values(config).some((value) => value === undefined) ||
    !config.keys.length
  ) {
    return undefined;
  }

  return config;
}

function parsePackedPlayerFileUrl(html) {
  const packedMatch = html.match(
    /\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([^']*)'\.split\('\|'\)\)\)/,
  );
  if (!packedMatch) {
    return undefined;
  }

  const [, packedCode, radixValue, wordCountValue, dictionary] = packedMatch;
  const radix = Number(radixValue);
  const wordCount = Number(wordCountValue);
  const words = dictionary.split('|');
  if (
    !Number.isInteger(radix) ||
    radix < 2 ||
    radix > 36 ||
    !Number.isInteger(wordCount)
  ) {
    return undefined;
  }

  let unpackedCode = packedCode;
  for (let index = Math.min(wordCount, words.length) - 1; index >= 0; index--) {
    if (words[index]) {
      const token = index.toString(radix);
      unpackedCode = unpackedCode.replace(
        new RegExp(`\\b${token}\\b`, 'g'),
        () => words[index],
      );
    }
  }

  const fileMatch = unpackedCode.match(/\bfile\s*:\s*("(?:\\.|[^"\\])*")/);
  return fileMatch ? JSON.parse(fileMatch[1]) : undefined;
}

function normalizeM3u8Url(url) {
  return url.replace(/^ttps:\/\//i, 'https://');
}

const pathMappings = {
  'New release': '/category/jav/?orderby=date&order=DESC',
  Decensored: '/category/decensored/',
  Amateur: '/category/amateur/',
  Idol: '/category/idol/',
  FC2: '/category/fc2/',
  '4K': '/category/4k/',
  'Popular Month': '/category/jav/?orderby=views-monthly&order=DESC',
};

class JavguruProvider extends Provider {
  constructor() {
    super('https://jav.guru', 'jav', 24);
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

  static create() {
    return new JavguruProvider();
  }

  getInitialUrl() {
    return `${this.baseUrl}/category/jav/`;
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/?s=${keyword}/`;
  }

  handleGenre({ extra: { genre } }) {
    return this.getGenreCatalogUrl(genre, pathMappings);
  }

  handlePagination(url, { extra: { skip } }) {
    const skipOffset = Number(skip);
    if (!Number.isFinite(skipOffset) || skipOffset <= 0) {
      return '';
    }

    const pageNumber = Math.floor(skipOffset / this.limit) + 1;
    if (url.includes('?')) {
      return `&paged=${pageNumber}`;
    }
    return `${url.endsWith('/') ? '' : '/'}page/${pageNumber}/`;
  }

  async getCatalogMetas(html) {
    const metadatas = [];
    const $ = load(html);

    $('.inside-article').each((_, element) => {
      const $article = $(element);
      const $imageContainer = $article.find('.imgg').first();
      const $link = $imageContainer.find('a[href]').first();
      const $image = $imageContainer.find('img').first();

      if (!$link.length) {
        return;
      }

      const videoPageUrl = new URL($link.attr('href'), this.baseUrl).toString();

      const imageUrl = [
        'data-front-lazy-src',
        'data-src',
        'data-lazy-src',
        'data-original',
        'src',
      ]
        .map((attribute) => $image.attr(attribute)?.trim())
        .find(
          (value) =>
            value &&
            !value.startsWith('data:image/') &&
            !/placeholder/i.test(value),
        );
      const poster = imageUrl
        ? new URL(imageUrl, `${this.baseUrl}/`).toString()
        : undefined;
      const title =
        $image.attr('alt')?.trim() ||
        $link.attr('title')?.trim() ||
        $link.text().trim();

      if (videoPageUrl) {
        metadatas.push(
          new meta.MetaPreview(videoPageUrl, Provider.TYPE, title, poster, {
            videoPageUrl,
          }),
        );
      }
    });

    await Promise.all(
      metadatas.map(async (metadata) => {
        if (metadata.poster) {
          metadata.poster = await getProxiedUrl(metadata.poster, {
            Origin: new URL(this.baseUrl).origin,
            Referer: `${this.baseUrl}/`,
          });
        }
      }),
    );
    return metadatas;
  }

  async getMetadata({ id }) {
    const html = await this.fetchHtml(id);
    const videoPage = await this.parseVideoPage({ id, html });
    return videoPage.metaResponse;
  }

  async fetchHtml(url, options = {}) {
    const parsedUrl = new URL(url);
    const urlLabel = `${parsedUrl.origin}${parsedUrl.pathname}`;
    const response = await fetch(url, {
      credentials: 'include',
      ...options,
    });
    if (!response.ok) {
      throw new Error(
        `Javguru request failed with status ${response.status} for ${urlLabel}`,
      );
    }
    return await response.text();
  }

  async processStreams({ id }) {
    return this.fetchHtml(this.baseUrl)
      .then(() => this.fetchHtml(id))
      .then(async (html) => {
        const videoPage = await this.parseVideoPage({ id, html });
        return this.getStreams(videoPage);
      });
  }

  async parseVideoPage({ id, html }) {
    const $ = load(html);
    const metaMap = {};
    $('meta').each((_, element) => {
      const { name, property, content } = element.attribs;
      const key = name || property;
      if (key) {
        metaMap[key] = content;
      }
    });
    const $posterImage = $('.large-screenimg img[src]').first();
    const title =
      $('h1.titl').first().text().trim() || $('title').first().text().trim();
    const posterUrl = $posterImage.attr('src')?.trim() || metaMap['og:image'];
    let poster = posterUrl ? new URL(posterUrl, id).toString() : undefined;

    if (poster) {
      poster = await getProxiedUrl(poster, {
        Origin: new URL(this.baseUrl).origin,
        Referer: `${this.baseUrl}/`,
      });
    }

    const description =
      $posterImage.attr('alt')?.trim() ||
      metaMap['og:description'] ||
      title ||
      metaMap.description;
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
      .filter(({ name }) => name);
    const genres = tagElements.map(({ name }) => name);
    const links = this.getMetaGenreLinks('javguru', tagElements);

    const iframeLocalize = $('#wp-btn-iframe')
      .filter((_, element) => $(element).text().trim() === 'STREAM JK')
      .first()
      .attr('data-localize');

    if (!iframeLocalize || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(iframeLocalize)) {
      throw new Error('Javguru STREAM JK data-localize was not found');
    }

    const localizedConfigMatch = $('#wp-btn-iframe-js-extra')
      .text()
      .match(
        new RegExp(
          `\\bvar\\s+${iframeLocalize}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`,
        ),
      );
    const localizedConfig = localizedConfigMatch
      ? JSON.parse(localizedConfigMatch[1])
      : undefined;
    const iframeUrlBase64 = localizedConfig && localizedConfig.iframe_url;
    const decodedIframeUrl =
      typeof iframeUrlBase64 === 'string'
        ? Buffer.from(iframeUrlBase64, 'base64').toString('utf8').trim()
        : '';
    const iframeUrl = decodedIframeUrl
      ? new URL(decodedIframeUrl, id).toString()
      : undefined;

    if (!iframeUrl) {
      throw new Error('Javguru STREAM JK iframeUrl was not found');
    }

    const iframeHtml = await this.fetchHtml(iframeUrl);
    const iframePageConfig = parseWindowConfig(iframeHtml);

    if (!iframePageConfig) {
      throw new Error('Javguru iframePageConfig was not found');
    }

    const $iframePage = load(iframeHtml);
    const $container = $iframePage('[id]')
      .filter((_, element) => element.attribs.id === iframePageConfig.cid)
      .first();
    const tokenParts = iframePageConfig.keys.map((key) => $container.attr(key));

    if (tokenParts.some((part) => !part)) {
      throw new Error('Javguru realSrc token was not found');
    }

    const token = tokenParts.join('').split('').reverse().join('');
    const videoPageUrl = `${iframePageConfig.base}?${iframePageConfig.rtype}r=${token}`;

    // console.log('[Javguru] Resolved realSrc URL:', videoPageUrl);

    const playerHtml = await this.fetchHtml(videoPageUrl);
    const m3u8Url = parsePackedPlayerFileUrl(playerHtml);

    if (!m3u8Url || !/\.m3u8(?:$|[?#])/i.test(m3u8Url)) {
      throw new Error('Javguru HLS playlist URL was not found in player HTML');
    }

    const normalizedM3u8Url = normalizeM3u8Url(m3u8Url);
    // console.log('[Javguru] Resolved m3u8 URL:', normalizedM3u8Url);

    const videoSources = [
      {
        url: new URL(normalizedM3u8Url, videoPageUrl).toString(),
        type: 'application/vnd.apple.mpegurl',
        name: 'HLS',
      },
    ];

    const metaResponse = new meta.MetaResponse(id, Provider.TYPE, title, {
      description: description,
      poster: poster,
      background: poster,
      genres: genres,
      genre: genres,
      links,
      videoPageUrl: normalizedM3u8Url,
    });

    return {
      metaResponse,
      videoPageUrl,
      videoSources,
    };
  }

  async getStreams(videoPage) {
    const videoSources = Array.isArray(videoPage.videoSources)
      ? videoPage.videoSources
      : [];
    const hlsSource = videoSources.find(
      (source) =>
        /mpegurl|m3u8/i.test(source.type) ||
        /\.m3u8(?:$|[?#])/i.test(source.url),
    );
    const mp4Sources = videoSources.filter((source) =>
      /video\/mp4/i.test(source.type),
    );

    if (!hlsSource && !mp4Sources.length) {
      return super.getStreams(videoPage);
    }

    const referer =
      videoPage.metaResponse && videoPage.metaResponse.id
        ? videoPage.metaResponse.id
        : this.baseUrl;
    const behaviorHints = {
      proxyHeaders: {
        request: {
          Origin: new URL(referer).origin,
          Referer: referer,
        },
      },
    };
    const streams = [];
    if (hlsSource) {
      // const hlsOrigin = new URL(hlsSource.url).origin.replace(/^(https?:\/\/)s\d+\./, '$1');
      streams.push({
        type: Provider.TYPE,
        url: await getProxiedUrl(
          hlsSource.url,
          behaviorHints.proxyHeaders.request,
        ),
        name: hlsSource.name || 'HLS',
      });
    }

    const mp4Streams = await Promise.all(
      mp4Sources.map(async (source) => {
        const sourceUrl = new URL(source.url);
        const isPlayback = sourceUrl.origin === new URL(this.baseUrl).origin;
        const requestHeaders = {
          ...behaviorHints.proxyHeaders.request,
          ...(isPlayback ? { Referer: `${this.baseUrl}/` } : {}),
        };
        return {
          type: Provider.TYPE,
          url: await getProxiedUrl(source.url, requestHeaders),
          name: source.name,
        };
      }),
    );

    streams.push(...mp4Streams);

    return { streams };
  }

  transformStream(url, stream) {
    return { ...stream, url: new URL(stream.url, url).toString() };
  }
}

module.exports = JavguruProvider.create;
module.exports.normalizeM3u8Url = normalizeM3u8Url;
