const { load } = require('cheerio');
const { meta } = require('../model');
const Provider = require('./provider');
const { getProxiedUrl } = require('./hls-proxy');

const pathMappings = {
  'New release': '/videos',
  Censored: '/censored',
  Uncensored: '/uncensored',
  'Reducing Mosaic': '/reducing-mosaic',
  'Popular Today': '/videos?sort=popular_today',
  'Popular Week': '/videos?sort=popular_week',
  'Popular Month': '/videos?sort=popular_month',
};

class JavtifulProvider extends Provider {
  constructor() {
    super('https://javtiful.com', 'javtiful', 20);
  }

  static create() {
    return new JavtifulProvider();
  }

  getInitialUrl() {
    return this.baseUrl + '/videos';
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/search?q=${keyword}/`;
  }

  handleGenre({ extra: { genre } }) {
    return this.getGenreCatalogUrl(genre, pathMappings);
  }

  handlePagination(url, { extra: { skip } }) {
    const prefix = url.indexOf('?') !== -1 ? '&' : '?';
    const skipOffset = Number(skip);
    if (!Number.isFinite(skipOffset) || skipOffset <= 0) {
      return '';
    }

    const page = Math.floor(skipOffset / this.limit) + 1;
    return `${prefix}page=${page}`;
  }

  async getCatalogMetas(html) {
    const metadatas = [];
    const $ = load(html);

    $('.video-grid article.video-card').each((_, element) => {
      const $article = $(element);
      const $link = $article.find('a[href]').first();

      if (!$link.length) {
        return;
      }

      const videoPageUrl = new URL($link.attr('href'), this.baseUrl).toString();
      const $thumbnailImage = $article
        .find('.video-card__thumbnail img')
        .first();
      const $image = $thumbnailImage.length
        ? $thumbnailImage
        : $article.find('img').first();
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
            !/video-thumb-placeholder\.svg(?:$|[?#])/i.test(value),
        );
      const poster = imageUrl
        ? new URL(imageUrl, `${this.baseUrl}/`).toString()
        : undefined;
      const imageTitle = $image.attr('alt') || '';
      const title =
        imageTitle.replace(/^Thumbnail for\s*/i, '').trim() ||
        $link.attr('title') ||
        $article.find('.video-card__title').first().text().trim() ||
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

  async getMetadata(args) {
    // console.log('[Javtiful] getMetadata Super url', args.videoPageUrl || args.id);
    return super.getMetadata(args).then((meta) => meta.metaResponse);
  }

  async fetchHtml(url) {
    // console.log('[Javtiful] Fetching URL:', url);
    try {
      const response = await fetch(url, { credentials: 'include' });
      return await response.text();
    } catch (error) {
      console.error('[Javtiful] Error fetching URL:', url, error);
      return '';
    }
  }

  async requestJson(url, { ticket, referer }) {
    const endpoint = new URL(url);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: endpoint.origin,
        Referer: referer,
      },
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({ ticket: ticket || '' }).toString(),
    });

    // console.log('[Javtiful] Playback endpoint status:', response.status);
    const contentType = response.headers.get('content-type') || '';
    const finalUrl = new URL(response.url || url);
    const finalEndpoint = `${finalUrl.origin}${finalUrl.pathname}`;
    // console.log('[Javtiful] Playback response headers:', {
    //  contentType,
    //  finalEndpoint,
    //});
    if (!response.ok) {
      const message = `Javtiful playback request failed with status ${response.status}`;
      // console.log('[Javtiful]', message);
      throw new Error(message);
    }

    let body;
    try {
      body = await response.text();
      return JSON.parse(body);
    } catch (error) {
      const responseTitle = load(body || '')('title')
        .first()
        .text()
        .trim()
        .slice(0, 120);
      console.log('[Javtiful] Playback endpoint returned invalid JSON:', {
        error: error.message,
        contentType,
        finalEndpoint,
        responseTitle: responseTitle || undefined,
      });
      throw error;
    }
  }

  async parseVideoPage({ id, html }) {
    const $ = load(html);
    const metaMap = {};
    $('meta').each((i, element) => {
      const attribs = element.attribs;
      metaMap[attribs.name || attribs.property] = attribs.content;
    });

    const watchConfig = $('#watch-config').text().trim();
    if (!watchConfig) {
      // console.log('[Javtiful] Error: watch-config script was not found');
      throw new Error('Javtiful watch-config script was not found');
    }

    const config = JSON.parse(watchConfig);

    const playback = config && config.playback;
    if (!playback || !playback.endpoint) {
      // console.log('[Javtiful] Error: playback endpoint was not found in watch-config');
      throw new Error(
        'Javtiful playback endpoint was not found in watch-config',
      );
    }

    const playbackUrl = new URL(playback.endpoint, id);
    // console.log('[Javtiful] Playback ticket present:', Boolean(playback.ticket));

    const playbackResponse = await this.requestJson(playbackUrl.toString(), {
      ticket: playback.ticket,
      referer: id,
    });
    if (
      !playbackResponse ||
      playbackResponse.success === false ||
      !Array.isArray(playbackResponse.sources)
    ) {
      // console.log('[Javtiful] Error: playback response did not contain sources');
      throw new Error('Javtiful playback response did not contain sources');
    }

    const videoSources = playbackResponse.sources
      .filter((source) => source && typeof source.src === 'string')
      .map((source) => ({
        url: new URL(source.src, playbackUrl).toString(),
        type: source.type || '',
        name: source.label || (source.size ? `${source.size}p` : 'Default'),
        size: Number(source.size) || 0,
      }))
      .sort((a, b) => b.size - a.size);
    if (!videoSources.length) {
      // console.log('[Javtiful] Error: playback response contained no usable source URLs');
      throw new Error(
        'Javtiful playback response contained no usable source URLs',
      );
    }

    const hlsSource = videoSources.find(
      (source) =>
        /mpegurl|m3u8/i.test(source.type) ||
        /\.m3u8(?:$|[?#])/i.test(source.url),
    );
    const videoPageUrl = (hlsSource || videoSources[0]).url;
    let poster =
      metaMap['og:video:image'] ||
      metaMap['og:image'] ||
      metaMap['twitter:image'];

    if (poster) {
      poster = await getProxiedUrl(poster, {
        Origin: new URL(this.baseUrl).origin,
        Referer: `${this.baseUrl}/`,
      });
    }

    const tagGenres = $('.watch-detail')
      .filter(
        (_, element) =>
          $(element).find('strong').first().text().trim().toLowerCase() ===
          'tags',
      )
      .find('a.watch-link-chip')
      .map((_, element) => ({
        name: $(element).text().trim(),
        href: $(element).attr('href'),
      }))
      .get()
      .filter(({ name }) => name);
    const genres = tagGenres.length
      ? tagGenres.map(({ name }) => name)
      : (metaMap.keywords || '')
          .split(',')
          .map((genre) => genre.trim())
          .filter(Boolean);
    const links = this.getMetaGenreLinks('javtiful', tagGenres);
    const metaResponse = new meta.MetaResponse(
      id,
      Provider.TYPE,
      metaMap['og:title'] || metaMap.title || '',
      {
        poster: poster,
        background: poster,
        description: metaMap['og:description'] || metaMap.description || '',
        genres: genres,
        genre: genres,
        links,
        videoPageUrl,
      },
    );

    // console.log('[Javtiful] Parsed video done:', videoPageUrl);

    return {
      metaResponse,
      videoPageUrl,
      videoSources,
    };
  }

  async processStreams({ id }) {
    return this.fetchHtml(this.baseUrl)
      .then(() => this.fetchHtml(id))
      .then(async (html) => {
        const videoPage = await this.parseVideoPage({ id, html });
        return this.getStreams(videoPage);
      });
  }

  async getStreams(videoPage) {
    const hlsSource = videoPage.videoSources.find(
      (source) =>
        /mpegurl|m3u8/i.test(source.type) ||
        /\.m3u8(?:$|[?#])/i.test(source.url),
    );
    const javtifulOrigin = new URL(this.baseUrl).origin;
    const mp4Sources = videoPage.videoSources.filter((source) => {
      const sourceUrl = new URL(source.url);
      const isJavtifulMediaEndpoint =
        sourceUrl.origin === javtifulOrigin &&
        /^\/media\/video\/\d+\/[^/]+\/?$/i.test(sourceUrl.pathname);
      return (
        /video\/mp4/i.test(source.type) ||
        /\.mp4(?:$|[?#])/i.test(source.url) ||
        isJavtifulMediaEndpoint
      );
    });

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
        const isJavtifulPlayback =
          sourceUrl.origin === new URL(this.baseUrl).origin;
        const requestHeaders = {
          ...behaviorHints.proxyHeaders.request,
          ...(isJavtifulPlayback ? { Referer: `${this.baseUrl}/` } : {}),
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

module.exports = JavtifulProvider.create;
