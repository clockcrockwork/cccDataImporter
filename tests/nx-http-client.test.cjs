const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const nxRequire = createRequire(require.resolve('nx/package.json'));

test('Nx uses the patched Undici client with its supported request API', async () => {
  const undici = nxRequire('undici');
  const packageJson = JSON.parse(require('node:fs').readFileSync(nxRequire.resolve('undici/package.json'), 'utf8'));
  assert.equal(packageJson.version, '7.30.1');

  const mockAgent = new undici.MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.get('https://fixture.invalid')
    .intercept({ path: '/status', method: 'GET' })
    .reply(200, { status: 'ok' }, { headers: { 'content-type': 'application/json' } });
  try {
    const response = await undici.request('https://fixture.invalid/status', { dispatcher: mockAgent });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await response.body.json(), { status: 'ok' });
  } finally {
    await mockAgent.close();
  }
});
