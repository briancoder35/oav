const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const test = require('node:test');
const createJavguruProvider = require('../provider/javguru');
const createJavtifulProvider = require('../provider/javtiful');
const {
  clearHlsProxyResources,
  setHlsProxyOrigin,
} = require('../provider/hls-proxy');

const proxyOrigin = 'https://addon.example';

test('Javtiful returns playback streams when proxying the poster', async (t) => {
  setHlsProxyOrigin(proxyOrigin);
  t.after(clearHlsProxyResources);

  const provider = createJavtifulProvider();
  provider.fetchHtml = async (url) =>
    url === provider.baseUrl
      ? ''
      : `
    <meta property="og:image" content="https://images.example/poster.jpg">
    <script id="watch-config" type="application/json">
      {"playback":{"endpoint":"/api/playback","ticket":"ticket"}}
    </script>
  `;
  provider.requestJson = async () => ({
    success: true,
    sources: [
      {
        src: 'https://media.example/playlist.m3u8',
        type: 'application/vnd.apple.mpegurl',
        label: 'HD',
      },
    ],
  });

  const result = await provider.processStreams({
    id: 'https://javtiful.com/video/example',
  });

  assert.equal(result.streams.length, 1);
  assert.match(
    result.streams[0].url,
    new RegExp(`^${proxyOrigin}/hls-proxy/[a-f0-9]{48}$`),
  );
});

test('Javguru returns playback streams when proxying the poster', async (t) => {
  setHlsProxyOrigin(proxyOrigin);
  t.after(clearHlsProxyResources);

  const provider = createJavguruProvider();
  const iframeUrl = 'https://iframe.example/watch';
  const iframeUrlBase64 = Buffer.from(iframeUrl).toString('base64');
  const videoPageUrl = 'https://player.example/resolve?xr=dcba';
  provider.fetchHtml = async (url) => {
    if (url === provider.baseUrl) {
      return '';
    }
    if (url === 'https://jav.guru/video/example') {
      return `
        <meta property="og:image" content="https://images.example/poster.jpg">
        <h1 class="titl">Example video</h1>
        <button id="wp-btn-iframe" data-localize="playerConfig">STREAM JK</button>
        <script id="wp-btn-iframe-js-extra">
          var playerConfig = {"iframe_url":"${iframeUrlBase64}"};
        </script>
      `;
    }
    if (url === iframeUrl) {
      return `
        <script>
          window.cfg = {
            cid: 'container',
            base: 'https://player.example/resolve',
            rtype: 'x',
            cls: 'video',
            keys: ['data-k']
          };
        </script>
        <div id="container" data-k="abcd"></div>
      `;
    }
    if (url === videoPageUrl) {
      return `}('file:"https://media.example/playlist.m3u8"',10,1,'file'.split('|')))`;
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await provider.processStreams({
    id: 'https://jav.guru/video/example',
  });

  assert.equal(result.streams.length, 1);
  assert.match(
    result.streams[0].url,
    new RegExp(`^${proxyOrigin}/hls-proxy/[a-f0-9]{48}$`),
  );
});
