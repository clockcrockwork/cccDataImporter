import { jest, beforeAll, beforeEach, afterEach, test, expect } from '@jest/globals';

let fetchWithRetry;
let postDiscordOrThrow;

function createResponse({ ok, status = 200, body = '', retryAfter }) {
  return {
    ok,
    status,
    headers: {
      get: (headerName) => {
        if (headerName.toLowerCase() !== 'retry-after') {
          return null;
        }

        return retryAfter ?? null;
      }
    },
    async text() {
      return body;
    }
  };
}

beforeAll(async () => {
  const module = await import('../httpClient.js');
  fetchWithRetry = module.fetchWithRetry;
  postDiscordOrThrow = module.postDiscordOrThrow;
});

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('fetchWithRetry returns response on first success', async () => {
  let callCount = 0;
  const fetchImpl = jest.fn(async () => {
    callCount += 1;
    return createResponse({ ok: true, status: 200 });
  });

  const response = await fetchWithRetry('https://example.com', {}, {
    jobName: 'test:firstSuccess',
    fetchImpl,
    baseDelayMs: 0
  });

  expect(response.status).toBe(200);
  expect(callCount).toBe(1);
});

test('fetchWithRetry retries on 5xx and then succeeds', async () => {
  let callCount = 0;
  const delays = [];
  const sleepImpl = jest.fn(async (ms) => {
    delays.push(ms);
  });

  const fetchImpl = jest.fn(async () => {
    callCount += 1;

    if (callCount === 1) {
      return createResponse({ ok: false, status: 500, body: 'temporary failure' });
    }

    return createResponse({ ok: true, status: 200 });
  });

  const response = await fetchWithRetry('https://example.com', {}, {
    jobName: 'test:retry5xx',
    fetchImpl,
    sleepImpl,
    maxRetries: 2,
    baseDelayMs: 50
  });

  expect(response.status).toBe(200);
  expect(callCount).toBe(2);
  expect(delays).toEqual([50]);
});

test('fetchWithRetry does not retry on 4xx and throws with details', async () => {
  let callCount = 0;
  const sleepImpl = jest.fn(async () => {});
  const fetchImpl = jest.fn(async () => {
    callCount += 1;
    return createResponse({ ok: false, status: 400, body: 'bad request details' });
  });

  await expect(fetchWithRetry('https://example.com', {}, {
    jobName: 'test:noRetry4xx',
    fetchImpl,
    sleepImpl,
    maxRetries: 3,
    baseDelayMs: 10
  })).rejects.toThrow('method=GET, url=https://example.com/, status=400, responseSnippet=bad request details');

  expect(callCount).toBe(1);
  expect(sleepImpl).not.toHaveBeenCalled();
});

test('fetchWithRetry uses Retry-After header when status is 429', async () => {
  let callCount = 0;
  const delays = [];
  const sleepImpl = jest.fn(async (ms) => {
    delays.push(ms);
  });

  const fetchImpl = jest.fn(async () => {
    callCount += 1;

    if (callCount === 1) {
      return createResponse({ ok: false, status: 429, body: 'rate limited', retryAfter: '2' });
    }

    return createResponse({ ok: true, status: 200 });
  });

  const response = await fetchWithRetry('https://example.com', {}, {
    jobName: 'test:retryAfter',
    fetchImpl,
    sleepImpl,
    maxRetries: 2,
    baseDelayMs: 50
  });

  expect(response.status).toBe(200);
  expect(delays).toEqual([2000]);
});

test('fetchWithRetry falls back to exponential backoff when Retry-After is invalid', async () => {
  const delays = [];
  const sleepImpl = jest.fn(async (ms) => {
    delays.push(ms);
  });

  const fetchImpl = jest.fn()
    .mockResolvedValueOnce(createResponse({ ok: false, status: 429, body: 'rate limited', retryAfter: 'abc' }))
    .mockResolvedValueOnce(createResponse({ ok: true, status: 200 }));

  await fetchWithRetry('https://example.com', {}, {
    jobName: 'test:retryAfterFallback',
    fetchImpl,
    sleepImpl,
    maxRetries: 2,
    baseDelayMs: 50
  });

  expect(delays).toEqual([50]);
});

test('fetchWithRetry caps Retry-After delay to upper bound', async () => {
  const delays = [];
  const sleepImpl = jest.fn(async (ms) => {
    delays.push(ms);
  });

  const fetchImpl = jest.fn()
    .mockResolvedValueOnce(createResponse({ ok: false, status: 429, body: 'rate limited', retryAfter: '120' }))
    .mockResolvedValueOnce(createResponse({ ok: true, status: 200 }));

  await fetchWithRetry('https://example.com', {}, {
    jobName: 'test:retryAfterCap',
    fetchImpl,
    sleepImpl,
    maxRetries: 2,
    baseDelayMs: 50
  });

  expect(delays).toEqual([30000]);
});

test('postDiscordOrThrow sends JSON payload with POST', async () => {
  const calls = [];
  const fetchImpl = jest.fn(async (url, options) => {
    calls.push({ url, options });
    return createResponse({ ok: true, status: 204 });
  });

  await postDiscordOrThrow({
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
    payload: { content: 'hello' },
    jobName: 'test:discordPost',
    fetchImpl,
    sleepImpl: async () => {}
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://discord.com/api/webhooks/123/abc');
  expect(calls[0].options.method).toBe('POST');
  expect(calls[0].options.headers['Content-Type']).toBe('application/json');

  const sentPayload = JSON.parse(calls[0].options.body);
  expect(sentPayload.content).toBe('hello');
  expect(sentPayload.allowed_mentions).toEqual({ parse: [] });
});

test('postDiscordOrThrow throws on missing webhookUrl', async () => {
  await expect(postDiscordOrThrow({
    webhookUrl: '',
    payload: { content: 'hello' },
    jobName: 'test:missingUrl'
  })).rejects.toThrow('Discord webhook URL is not configured');
});

test('postDiscordOrThrow throws on non-Discord URL', async () => {
  await expect(postDiscordOrThrow({
    webhookUrl: 'https://example.com/api/webhooks/123/abc',
    payload: { content: 'hello' },
    jobName: 'test:nonDiscordUrl'
  })).rejects.toThrow('Webhook URL must be an https Discord webhook endpoint');
});

test('postDiscordOrThrow throws on http URL', async () => {
  await expect(postDiscordOrThrow({
    webhookUrl: 'http://discord.com/api/webhooks/123/abc',
    payload: { content: 'hello' },
    jobName: 'test:httpUrl'
  })).rejects.toThrow('Webhook URL must be an https Discord webhook endpoint');
});

test('postDiscordOrThrow throws on null payload', async () => {
  await expect(postDiscordOrThrow({
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
    payload: null,
    jobName: 'test:nullPayload'
  })).rejects.toThrow('Discord payload must be a non-null object');
});

test('postDiscordOrThrow throws on string payload', async () => {
  await expect(postDiscordOrThrow({
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
    payload: 'hello',
    jobName: 'test:stringPayload'
  })).rejects.toThrow('Discord payload must be a non-null object');
});

test('postDiscordOrThrow throws on array payload', async () => {
  await expect(postDiscordOrThrow({
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
    payload: [1, 2],
    jobName: 'test:arrayPayload'
  })).rejects.toThrow('Discord payload must be a non-null object');
});

test('postDiscordOrThrow normalizes payload with content truncation and allowed_mentions', async () => {
  const calls = [];
  const fetchImpl = jest.fn(async (url, options) => {
    calls.push({ url, options });
    return createResponse({ ok: true, status: 204 });
  });

  const longContent = 'x'.repeat(2100);

  await postDiscordOrThrow({
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
    payload: { content: longContent },
    jobName: 'test:normalize',
    fetchImpl,
    sleepImpl: async () => {}
  });

  const sentPayload = JSON.parse(calls[0].options.body);
  expect(sentPayload.content.length).toBe(2000);
  expect(sentPayload.allowed_mentions).toEqual({ parse: [] });
});
