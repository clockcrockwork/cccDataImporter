import fetch from 'node-fetch';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const RESPONSE_SNIPPET_MAX_LENGTH = 300;
const DEFAULT_MAX_RETRY_AFTER_MS = 30000;

const RETRYABLE_STATUS_CODES = new Set([
  429,
  500,
  501,
  502,
  503,
  504,
  505,
  506,
  507,
  508,
  510,
  511
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getResponseSnippet(text) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, RESPONSE_SNIPPET_MAX_LENGTH);
}

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function buildFailureMeta({ jobName, url, method, status, responseSnippet, error }) {
  return {
    jobName,
    url: sanitizeUrl(url),
    method,
    status: status ?? 'N/A',
    responseSnippet: responseSnippet || 'N/A',
    error: error?.message || 'Unknown error'
  };
}

function logFailure(meta) {
  console.error('[http-client] request-failed', meta);
}

function createHttpError(meta, cause) {
  const error = new Error(
    `[${meta.jobName}] HTTP request failed: method=${meta.method}, url=${meta.url}, status=${meta.status}, responseSnippet=${meta.responseSnippet}`
  );

  if (cause) {
    error.cause = cause;
  }

  error.meta = meta;
  return error;
}

function parseRetryAfterToMs(value) {
  if (!value) {
    return null;
  }

  const asSeconds = Number(value);
  if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return null;
}

function resolveDelayMs({ response, attempt, baseDelayMs, maxRetryAfterMs }) {
  if (response?.status === 429) {
    const retryAfterHeader = response.headers?.get?.('retry-after');
    const retryAfterMs = parseRetryAfterToMs(retryAfterHeader);
    if (retryAfterMs !== null) {
      return Math.min(retryAfterMs, maxRetryAfterMs);
    }
  }

  return baseDelayMs * (2 ** attempt);
}

function resolveMethod(options) {
  if (options?.method) {
    return String(options.method).toUpperCase();
  }

  return 'GET';
}

export async function fetchWithRetry(url, options = {}, config = {}) {
  const {
    jobName = 'unknown-job',
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    fetchImpl = fetch,
    sleepImpl = sleep
  } = config;

  const method = resolveMethod(options);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const isFinalAttempt = attempt === maxRetries;

    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      const meta = buildFailureMeta({ jobName, url, method, error });
      if (isFinalAttempt) {
        logFailure(meta);
        throw createHttpError(meta, error);
      }

      logFailure({ ...meta, retryAttempt: attempt + 1 });
      await sleepImpl(baseDelayMs * (2 ** attempt));
      continue;
    }

    if (response.ok) {
      return response;
    }

    const responseText = await response.text();
    const responseSnippet = getResponseSnippet(responseText);
    const meta = buildFailureMeta({
      jobName,
      url,
      method,
      status: response.status,
      responseSnippet
    });

    const isRetryable = RETRYABLE_STATUS_CODES.has(response.status);

    if (!isRetryable || isFinalAttempt) {
      logFailure(meta);
      throw createHttpError(meta);
    }

    logFailure({ ...meta, retryAttempt: attempt + 1 });
    const delayMs = resolveDelayMs({ response, attempt, baseDelayMs, maxRetryAfterMs });
    await sleepImpl(delayMs);
  }

  throw new Error(`[${jobName}] Unexpected retry exit for url=${sanitizeUrl(url)}`);
}

const ALLOWED_DISCORD_HOSTS = ['discord.com', 'discordapp.com'];
const WEBHOOK_PATH_FRAGMENT = '/api/webhooks/';
const MAX_DISCORD_CONTENT_LEN = 2000;

function validateDiscordWebhookUrl(webhookUrl) {
  if (!webhookUrl) {
    throw new Error('Discord webhook URL is not configured.');
  }

  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error('Webhook URL must be an https Discord webhook endpoint.');
  }

  const host = (parsed.hostname || '').toLowerCase();
  const isAllowedHost = ALLOWED_DISCORD_HOSTS.some(
    allowed => host === allowed || host.endsWith(`.${allowed}`)
  );

  if (parsed.protocol !== 'https:' || !isAllowedHost || !parsed.pathname.includes(WEBHOOK_PATH_FRAGMENT)) {
    throw new Error('Webhook URL must be an https Discord webhook endpoint.');
  }
}

function normalizeDiscordPayload(payload) {
  const normalized = { ...payload };

  if (!normalized.allowed_mentions) {
    normalized.allowed_mentions = { parse: [] };
  }

  if (typeof normalized.content === 'string' && normalized.content.length > MAX_DISCORD_CONTENT_LEN) {
    normalized.content = normalized.content.slice(0, MAX_DISCORD_CONTENT_LEN);
  }

  return normalized;
}

export async function postDiscordOrThrow({ webhookUrl, payload, jobName, fetchImpl, sleepImpl }) {
  validateDiscordWebhookUrl(webhookUrl);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Discord payload must be a non-null object.');
  }
  const normalizedPayload = normalizeDiscordPayload(payload);

  await fetchWithRetry(
    webhookUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalizedPayload)
    },
    { jobName, fetchImpl, sleepImpl }
  );
}
