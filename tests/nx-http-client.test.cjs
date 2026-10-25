const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const nxRequire = createRequire(require.resolve('nx/package.json'));

test('Nx HTTP client uses patched Undici fetch for abortable JSON and response streams', async () => {
  const undici = nxRequire('undici');
  const packageJson = JSON.parse(require('node:fs').readFileSync(nxRequire.resolve('undici/package.json'), 'utf8'));
  assert.equal(packageJson.version, '7.30.1');

  const mockAgent = new undici.MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.get('http://fixture.invalid')
    .intercept({ path: '/json' })
    .reply(200, { status: 'ok' }, { headers: { 'content-type': 'application/json' } });
  mockAgent.get('http://fixture.invalid')
    .intercept({ path: '/slow' })
    .reply(200, '{"late":true}', { headers: { 'content-type': 'application/json' } })
    .delay(500);
  mockAgent.get('http://fixture.invalid')
    .intercept({ path: '/stream' })
    .reply(200, 'first-second', { headers: { 'content-type': 'application/octet-stream' } });

  const originalAgent = undici.EnvHttpProxyAgent;
  assert.equal(typeof originalAgent, 'function');
  const realAgent = new originalAgent({
    httpProxy: 'http://127.0.0.1:1',
    httpsProxy: 'http://127.0.0.1:1',
  });
  await realAgent.close();
  const oldEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    ALL_PROXY: process.env.ALL_PROXY,
    all_proxy: process.env.all_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  process.env.HTTP_PROXY = 'http://fixture-proxy.invalid';
  process.env.http_proxy = process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  process.env.NO_PROXY = '';
  process.env.no_proxy = '';
  undici.EnvHttpProxyAgent = function TestProxyAgent(options) {
    assert.deepEqual(options, { httpProxy: process.env.HTTP_PROXY, httpsProxy: undefined });
    return mockAgent;
  };

  try {
    const nxRoot = require('node:path').dirname(require.resolve('nx/package.json'));
    const { createHttpClient } = require(require('node:path').join(nxRoot, 'dist/src/utils/http-client'));
    const client = createHttpClient({ baseURL: 'http://fixture.invalid' });
    assert.deepEqual((await client.get('/json')).data, { status: 'ok' });

    const controller = new AbortController();
    const pending = client.get('/slow', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error.name === 'AbortError');

    const streamed = await client.get('/stream', { responseType: 'stream', timeout: 1000 });
    const chunks = [];
    for await (const chunk of streamed.data) chunks.push(chunk.toString());
    assert.equal(chunks.join(''), 'first-second');
  } finally {
    undici.EnvHttpProxyAgent = originalAgent;
    Object.entries(oldEnv).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
    await mockAgent.close();
  }
});
