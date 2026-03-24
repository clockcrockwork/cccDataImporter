import { postDiscordOrThrow } from './httpClient.js';

const DISCORD_MAX_CONTENT_LENGTH = 1900;

export function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch (_) {
    return String(error);
  }
}

export function sanitizeText(text) {
  if (typeof text !== 'string') {
    return text;
  }

  return text
    .replace(/https?:\/\/[^\s)]+/g, (value) => {
      try {
        const parsed = new URL(value);
        return `[REDACTED URL:${parsed.hostname}]`;
      } catch (_) {
        return '[REDACTED URL]';
      }
    })
    .replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, '[REDACTED ID]');
}

export async function handleError({ errors, label, webhookUrl, jobName }) {
  const errorArray = Array.isArray(errors) ? errors : [errors];
  const filtered = errorArray.filter(Boolean);

  if (filtered.length === 0) {
    return;
  }

  const rawMessage = filtered.map((err) => toErrorMessage(err)).join('\n');
  const sanitized = sanitizeText(rawMessage);

  console.log(`[${label}] Error:`, sanitized);

  if (!webhookUrl) {
    return;
  }

  const content = `【${label}】Errors occurred: ${sanitized}`.slice(0, DISCORD_MAX_CONTENT_LENGTH);

  try {
    await postDiscordOrThrow({
      webhookUrl,
      payload: { content },
      jobName
    });
  } catch (notifyError) {
    console.error(`[${label}] Failed to send error webhook:`, toErrorMessage(notifyError));
  }
}
