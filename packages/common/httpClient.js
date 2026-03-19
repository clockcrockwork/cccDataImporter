import fetch from 'node-fetch';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const RESPONSE_SNIPPET_MAX_LENGTH = 300;
const MAX_RETRY_AFTER_MS = 30000;

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

function buildFailureMeta({ jobName, url, status, responseSnippet, error }) {
  return {
    jobName,
    url,
    status: status ?? 'N/A',
    responseSnippet: responseSnippet || 'N/A',
    error: error?.message || 'Unknown error'
  };
}

function logFailure(meta) {
  console.error('[http-client] request-failed', meta);
}

function createHttpError(meta) {
  return new Error(
    `[${meta.jobName}] HTTP request failed: url=${meta.url}, status=${meta.status}, responseSnippet=${meta.responseSnippet}`
  );
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

function resolveDelayMs({ response, attempt, baseDelayMs }) {
  if (response?.status === 429) {
    const retryAfterHeader = response.headers?.get?.('retry-after');
    const retryAfterMs = parseRetryAfterToMs(retryAfterHeader);
    if (retryAfterMs !== null) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
  }

  return baseDelayMs * (2 ** attempt);
}

export async function fetchWithRetry(url, options = {}, config = {}) {
  const {
    jobName = 'unknown-job',
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    fetchImpl = fetch,
    sleepImpl = sleep
  } = config;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const isFinalAttempt = attempt === maxRetries;

    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      const meta = buildFailureMeta({ jobName, url, error });
      if (isFinalAttempt) {
        logFailure(meta);
        throw createHttpError(meta);
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
      status: response.status,
      responseSnippet
    });

    const isRetryable = RETRYABLE_STATUS_CODES.has(response.status);

    if (!isRetryable || isFinalAttempt) {
      logFailure(meta);
      throw createHttpError(meta);
    }

    logFailure({ ...meta, retryAttempt: attempt + 1 });
    const delayMs = resolveDelayMs({ response, attempt, baseDelayMs });
    await sleepImpl(delayMs);
  }

  throw new Error(`[${jobName}] Unexpected retry exit for url=${url}`);
}

export async function postDiscordOrThrow({ webhookUrl, payload, jobName, fetchImpl, sleepImpl }) {
  await fetchWithRetry(
    webhookUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    },
    { jobName, fetchImpl, sleepImpl }
  );
}
