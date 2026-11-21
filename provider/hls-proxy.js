const http = require('node:http');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const process = require('node:process');
const Provider = require('./provider');

const RESOURCE_TTL = 2 * 60 * 60 * 1000;
const MAX_RESOURCES = 30000;
const MAX_MANIFEST_SIZE = 8 * 1024 * 1024;
const resources = new Map();
let server;
let startPromise;
let proxyOrigin;

function isPrivateAddress(address) {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(normalized);

  if (family === 4) {
    const octets = normalized.split('.').map(Number);
    const [first, second] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      first >= 224
    );
  }

  if (family === 6) {
    if (normalized.startsWith('::ffff:')) {
      return true;
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }

  return false;
}

function validateUpstreamUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isPrivateAddress(hostname)
  ) {
    throw new Error('Unsupported HLS resource URL');
  }
  return url;
}

function pruneResources() {
  const now = Date.now();
  for (const [token, resource] of resources) {
    if (resource.expiresAt <= now) {
      resources.delete(token);
    }
  }
}

function registerResource(url, headers) {
  const upstreamUrl = validateUpstreamUrl(url);
  if (resources.size >= MAX_RESOURCES) {
    pruneResources();
  }
  if (resources.size >= MAX_RESOURCES) {
    throw new Error('HLS proxy resource limit reached');
  }

  const token = randomBytes(24).toString('hex');
  resources.set(token, {
    url: upstreamUrl.toString(),
    headers,
    expiresAt: Date.now() + RESOURCE_TTL,
  });
  return `${proxyOrigin}/${token}`;
}

function clearHlsProxyResources() {
  resources.clear();
}

function rewriteManifest(content, manifestUrl, headers) {
  const rewriteUri = (uri) =>
    registerResource(new URL(uri, manifestUrl).toString(), headers);
  return content
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (trimmed.startsWith('#')) {
        return line.replace(
          /\bURI=(["'])(.*?)\1/g,
          (_match, quote, uri) => `URI=${quote}${rewriteUri(uri)}${quote}`,
        );
      }
      const leadingWhitespace = line.match(/^\s*/)[0];
      const trailingWhitespace = line.match(/\s*$/)[0];
      return `${leadingWhitespace}${rewriteUri(trimmed)}${trailingWhitespace}`;
    })
    .join('\n');
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Range, If-Range, If-None-Match, If-Modified-Since',
  );
  response.setHeader('Cache-Control', 'no-store');
}

function copyResponseHeaders(upstream, response) {
  const canForwardContentLength = !upstream.headers.get('content-encoding');
  for (const name of [
    'accept-ranges',
    'content-range',
    'content-type',
    ...(canForwardContentLength ? ['content-length'] : []),
    'etag',
    'last-modified',
  ]) {
    const value = upstream.headers.get(name);
    if (value) {
      response.setHeader(name, value);
    }
  }
}

function getResourceToken(requestUrl) {
  let pathname;
  try {
    pathname = new URL(requestUrl, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
  const match = /^\/([a-f0-9]{48})$/.exec(pathname);
  return match && match[1];
}

async function fetchUpstream(resource, request, signal) {
  const headers = { ...resource.headers };
  headers['accept-encoding'] = 'identity';
  for (const name of [
    'accept',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'range',
    'user-agent',
  ]) {
    const value = request.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }

  let url = validateUpstreamUrl(resource.url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'manual',
      signal,
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, url };
    }
    await response.body?.cancel();
    if (redirects === 5) {
      throw new Error('Too many HLS resource redirects');
    }
    url = validateUpstreamUrl(new URL(location, url).toString());
  }

  throw new Error('Unable to fetch HLS resource');
}

async function handleProxyRequest(request, response) {
  setCorsHeaders(response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end();
    return;
  }

  const token = getResourceToken(request.url);
  const resource = token && resources.get(token);
  if (!resource || resource.expiresAt <= Date.now()) {
    if (token) {
      resources.delete(token);
    }
    response.writeHead(404).end('HLS resource not found');
    return;
  }

  const abortController = new AbortController();
  response.on('close', () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  });

  try {
    const { response: upstream, url } = await fetchUpstream(
      resource,
      request,
      abortController.signal,
    );
    response.statusCode = upstream.status;
    copyResponseHeaders(upstream, response);
    if (request.method === 'HEAD' || !upstream.body) {
      await upstream.body?.cancel();
      response.end();
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isManifest =
      /\.m3u8$/i.test(url.pathname) || /mpegurl/i.test(contentType);
    if (isManifest && upstream.ok) {
      const body = await upstream.text();
      if (body.length > MAX_MANIFEST_SIZE) {
        response.removeHeader('Content-Length');
        response.writeHead(502).end('HLS manifest is too large');
        return;
      }
      if (!body.trimStart().startsWith('#EXTM3U')) {
        response.end(body);
        return;
      }
      const manifest = rewriteManifest(body, url, resource.headers);
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.removeHeader('Content-Length');
      response.end(manifest);
      return;
    }

    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    if (response.destroyed) {
      return;
    }
    console.error('[HLS proxy] Request failed:', error);
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502).end('HLS upstream request failed');
  }
}

function startHlsProxy() {
  if (proxyOrigin) {
    return Promise.resolve(proxyOrigin);
  }
  if (startPromise) {
    return startPromise;
  }

  server = http.createServer((request, response) => {
    handleProxyRequest(request, response);
  });
  startPromise = new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      server = undefined;
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      proxyOrigin = `http://127.0.0.1:${address.port}`;
      resolve(proxyOrigin);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  return startPromise;
}

function setHlsProxyOrigin(origin) {
  const parsedOrigin = new URL(origin);
  clearHlsProxyResources();
  proxyOrigin = `${parsedOrigin.origin}/hls-proxy`;
}

function mountHlsProxy(app) {
  app.use('/hls-proxy', handleProxyRequest);
}

async function getProxiedUrl(url, headers = {}) {
  if (!proxyOrigin) {
    const hostName =
      process.env.HOST_NAME ||
      (process.env.PORT || process.env.NODE_ENV === 'production'
        ? Provider.TRANSPORT_URL
        : undefined);
    if (hostName) {
      const addonUrl = new URL(
        /^[a-z][a-z\d+.-]*:\/\//i.test(hostName)
          ? hostName
          : `https://${hostName}`,
      );
      setHlsProxyOrigin(addonUrl.origin);
    } else {
      await startHlsProxy();
    }
  }
  const proxyHeaders = {};
  for (const name of ['Origin', 'Referer']) {
    if (typeof headers[name] === 'string' && headers[name]) {
      proxyHeaders[name] = headers[name];
    }
  }
  return registerResource(url, proxyHeaders);
}

async function stopHlsProxy() {
  clearHlsProxyResources();
  if (!server) {
    return;
  }
  const activeServer = server;
  server = undefined;
  startPromise = undefined;
  proxyOrigin = undefined;
  await new Promise((resolve, reject) => {
    activeServer.close((error) => (error ? reject(error) : resolve()));
  });
}

module.exports = {
  getProxiedUrl,
  mountHlsProxy,
  clearHlsProxyResources,
  rewriteManifest,
  setHlsProxyOrigin,
  startHlsProxy,
  stopHlsProxy,
};
