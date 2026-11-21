const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');

class PorntrexProvider extends Provider {
  constructor() {
    super('https://porntrex.com/', 'porntrex', 85);
  }

  static create() {
    return new PorntrexProvider();
  }

  getInitialUrl(catalogId) {
    if (!catalogId) {
      return `${this.baseUrl}latest-updates/`;
    }

    if (catalogId.includes('top-rated')) {
      return `${this.baseUrl}top-rated/`;
    }

    if (catalogId.includes('most-popular')) {
      return `${this.baseUrl}most-popular/`;
    }

    return `${this.baseUrl}latest-updates/`;
  }

  getSegment(catalogId) {
    return catalogId.substring(this.getName().length + 1);
  }

  handleSearch({ id, extra: { search: keyword } }) {
    const segment = this.getSegment(id);
    return `${this.baseUrl}search/${keyword}/${segment}/`;
  }

  handleGenre(args) {
    return this.handleSearch({ ...args, extra: { search: args.extra.genre } });
  }

  handlePagination(url, { extra: { skip } }) {
    const page = Math.floor(skip / this.perPage) + 1;

    if (page <= 1) return url;

    const prefix = url.endsWith('/') ? '' : '/';
    return `${prefix}${page}/`;
  }

  extractVideoId(url) {
    const match = url.match(/\/video\/(\d+)\//);
    return match ? parseInt(match[1], 10) : null;
  }

  buildPoster(videoId) {
    const bucket = Math.floor(videoId / 1000) * 1000;
    return `https://ptx.cdntrex.com/contents/videos_screenshots/${bucket}/${videoId}/preview.mp4.jpg`;
  }

  async fetchHtml(url) {
    return super.fetchHtml(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',

        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

        'Accept-Language': 'en-US,en;q=0.9',

        Referer: 'https://www.porntrex.com/',

        Cookie: 'kt_tcookie=1; confirmed=true',
      },
    });
  }

  async resolveStream(url) {
    try {
      let res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://www.porntrex.com/',
          Cookie: 'kt_tcookie=1; confirmed=true',
        },
      });

      if (!res.url || res.status >= 400) {
        res = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://www.porntrex.com/',
            Cookie: 'kt_tcookie=1; confirmed=true',
          },
        });
      }

      return res.url;
    } catch (error) {
      logger.warn({ err: error, url }, 'Unable to resolve Porntrex stream URL');
      return null;
    }
  }

  getCatalogMetas(html) {
    const metas = [];
    const $ = load(html);
    const seen = new Set();

    $('div.video-item').each((_, element) => {
      const $e = $(element);
      const $a = $e.children('a').first();
      const videoPageUrl = $a.attr('href');

      if (!videoPageUrl) return;

      const id = new URL(videoPageUrl, this.baseUrl).href;

      if (seen.has(id)) return;

      seen.add(id);

      const $img = $a.children('img');
      let poster =
        this.buildPoster(this.extractVideoId(id)) ||
        $img.attr('data-src') ||
        $img.attr('data-srcset')?.split(',')[0]?.split(' ')[0] ||
        $img.attr('src');
      const title = ($img.attr('alt') || '').replace(/\s+/g, ' ').trim();

      if (poster && poster.startsWith('//')) {
        poster = 'https:' + poster;
      }

      metas.push(
        new meta.MetaPreview(id, Provider.TYPE, title, poster, {
          posterShape: 'landscape',
        }),
      );
    });

    return metas;
  }

  async getMetadata(args) {
    const html = await this.fetchHtml(args.id);
    const parsed = await this.parseVideoPage({ id: args.id, html });
    return parsed.metaResponse;
  }

  async parseVideoPage({ id, html }) {
    const $ = load(html);
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim();
    const description = $('meta[name="description"]').attr('content') || title;
    const videoId = this.extractVideoId(id);
    let poster;

    if (videoId) {
      poster = this.buildPoster(videoId);
    } else {
      poster = $('meta[property="og:image"]').attr('content');

      if (poster && poster.startsWith('//')) {
        poster = 'https:' + poster;
      }
    }
    const metaResponse = new meta.MetaResponse(id, Provider.TYPE, title, {
      description,
      poster,
      background: poster,
      posterShape: 'landscape',
    });

    const playerMatch = html.match(
      /kt_player\s*\(\s*['"][^'"]+['"]\s*,\s*(\{[\s\S]*?\})\s*\)/,
    );
    const streams = [];

    if (playerMatch) {
      const raw = playerMatch[1];
      const streamRegex = /video_alt_url(\d*)\s*:\s*'([^']+)'/g;
      const qualityMap = {
        '': '480p',
        2: '720p',
        3: '1080p',
        4: '1440p',
        5: '2160p',
      };
      let match;

      while ((match = streamRegex.exec(raw)) !== null) {
        const key = match[1] || '';
        let url = match[2];

        if (url.startsWith('//')) {
          url = 'https:' + url;
        }

        streams.push({
          url,
          quality: qualityMap[key] || '480p',
        });
      }
    }

    if (!streams.length) {
      const matches = html.match(/https?:\/\/[^"' ]+\.mp4[^"' ]*/g) || [];
      const unique = [...new Set(matches)];

      unique.forEach((url) => {
        const qualityMatch = url.match(/(\d{3,4})p/);
        let quality;

        if (qualityMatch) {
          quality = qualityMatch[1] + 'p';
        } else if (url.includes('.mp4')) {
          quality = '480p';
        } else {
          quality = 'HD';
        }

        streams.push({
          url,
          quality,
        });
      });
    }

    if (!streams.length) {
      return { metaResponse };
    }

    const seenUrls = new Set();
    const uniqueStreams = streams
      .filter((s) => {
        if (seenUrls.has(s.url)) return false;
        seenUrls.add(s.url);
        return true;
      })
      .sort((a, b) => {
        const qa = Number(a.quality.replace('p', '')) || 0;
        const qb = Number(b.quality.replace('p', '')) || 0;
        return qb - qa;
      });
    const resolvedStreams = await Promise.all(
      uniqueStreams.map(async (s) => {
        const finalUrl = await this.resolveStream(s.url);

        if (!finalUrl) return null;

        return {
          type: Provider.TYPE,
          url: finalUrl,
          name: s.quality,
          behaviorHints: {
            notWebReady: false,
          },
        };
      }),
    );

    return {
      metaResponse,
      streams: resolvedStreams.filter(Boolean),
    };
  }
}

module.exports = PorntrexProvider.create;
