import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, postDiscordOrThrow } from '../httpClient.js';

function createResponse({ ok, status = 200, body = '' }) {
  return {
    ok,
    status,
    async text() {
      return body;
    }
  };
}

test('fetchWithRetry returns response on first success', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return createResponse({ ok: true, status: 200 });
  };

  const response = await fetchWithRetry('https://example.com', {}, {
    jobName: 'test:firstSuccess',
    fetchImpl,
    baseDelayMs: 0
  });

  assert.equal(response.status, 200);
  assert.equal(callCount, 1);
});

test('fetchWithRetry retries on 5xx and then succeeds', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) {
      return createResponse({ ok: false, status: 500, body: 'temporary failure' });
    }

    return createResponse({ ok: true, status: 200 });
  };

  const response = await fetchWithRetry('https://example.com', {}, {
    jobName: 'test:retry5xx',
    fetchImpl,
    maxRetries: 2,
    baseDelayMs: 0
  });

  assert.equal(response.status, 200);
  assert.equal(callCount, 2);
});

test('fetchWithRetry does not retry on 4xx and throws with details', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return createResponse({ ok: false, status: 400, body: 'bad request details' });
  };

  await assert.rejects(
    () => fetchWithRetry('https://example.com', {}, {
      jobName: 'test:noRetry4xx',
      fetchImpl,
      maxRetries: 3,
      baseDelayMs: 0
    }),
    /status=400, responseSnippet=bad request details/
  );

  assert.equal(callCount, 1);
});

test('postDiscordOrThrow sends JSON payload with POST', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return createResponse({ ok: true, status: 204 });
  };

  await postDiscordOrThrow({
    webhookUrl: 'https://discord.test/webhook',
    payload: { content: 'hello' },
    jobName: 'test:discordPost',
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://discord.test/webhook');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.body, JSON.stringify({ content: 'hello' }));
});
