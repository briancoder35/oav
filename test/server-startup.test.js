const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('serves the manifest when analytics is not configured', () => {
  const script = `
    const serveHTTP = require('./server-sdk');
    const addon = require('./addon');

    (async () => {
      const { server, url } = await serveHTTP(addon, { port: 0 });
      try {
        const response = await fetch(url);
        const manifest = await response.json();
        if (!response.ok || manifest.id !== 'brian3596.onlyavideo') {
          throw new Error('The addon manifest was not served correctly');
        }
      } finally {
        server.close();
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, WRITE_KEY: '' },
    timeout: 5000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Analytics disabled: WRITE_KEY is not configured\./,
  );
});
