import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode } from 'html-entities';
import { fetchWithRetry, postDiscordOrThrow } from '../common/httpClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_ERROR_MESSAGE_LENGTH = 1000;
const MAX_ERROR_WEBHOOK_CONTENT_LENGTH = 1800;
const ALLOWED_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);

if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_DAILY_TABLE_NAME = process.env.SUPABASE_DAILY_TABLE_NAME;
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const PRODUCTHUNT_FEED_URL = process.env.PRODUCTHUNT_FEED_URL;
const DISCORD_DAILY_WEBHOOK_URL = process.env.DISCORD_DAILY_WEBHOOK_URL;

if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_DAILY_TABLE_NAME || !ERROR_WEBHOOK_URL || !PRODUCTHUNT_FEED_URL || !DISCORD_DAILY_WEBHOOK_URL) {
  throw new Error('Missing required environment variables.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export class BusinessValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessValidationError';
  }
}

function createErrorArray() {
  let errorArray = [];

  return {
    addError: (error) => errorArray.push(error),
    getErrors: () => errorArray
  };
}

function sanitizeErrorMessage(message) {
  return (message || 'Unknown error')
    .replace(/(https?:\/\/[^\s]*?(?:token|key|secret|webhook)[^\s]*)/ig, '[REDACTED_URL]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function toSafeContentHtml(value) {
  return typeof value === 'string' ? value : '';
}

function isSafeImageUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    return ALLOWED_IMAGE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function truncateForDiscord(content) {
  return content.length > MAX_ERROR_WEBHOOK_CONTENT_LENGTH
    ? `${content.slice(0, MAX_ERROR_WEBHOOK_CONTENT_LENGTH - 3)}...`
    : content;
}

async function getDiscordThreadId() {
  const { data, error } = await supabase
    .from(SUPABASE_DAILY_TABLE_NAME)
    .select('forum_id');

  if (error) {
    throw error;
  }

  const forumId = data?.[0]?.forum_id;
  if (!forumId || typeof forumId !== 'string' || forumId.trim().length === 0) {
    throw new BusinessValidationError('Invalid forum_id: missing Discord thread id.');
  }

  return forumId;
}

function validateItemShape(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new BusinessValidationError(`Invalid Product Hunt response: item at index ${index} must be an object.`);
  }

  if (typeof item.title !== 'string' || item.title.trim().length === 0) {
    throw new BusinessValidationError(`Invalid Product Hunt response: item at index ${index} has invalid title.`);
  }

  if (typeof item.url !== 'string' || item.url.trim().length === 0) {
    throw new BusinessValidationError(`Invalid Product Hunt response: item at index ${index} has invalid url.`);
  }
}

export function validateProductHuntPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BusinessValidationError('Invalid Product Hunt response: root data must be an object.');
  }

  if (!Array.isArray(data.items)) {
    throw new BusinessValidationError('Invalid Product Hunt response: data.items must be an array.');
  }

  if (data.items.length === 0) {
    throw new BusinessValidationError('Invalid Product Hunt response: data.items must not be empty.');
  }

  data.items.forEach(validateItemShape);

  return data.items;
}

export async function fetchProductHuntData() {
  const response = await fetchWithRetry(PRODUCTHUNT_FEED_URL, {}, { jobName: 'getPopularProducts:fetchProductHuntData' });
  const data = await response.json();
  return validateProductHuntPayload(data);
}

function extractImages(contentHtml) {
  const imgUrls = [...toSafeContentHtml(contentHtml).matchAll(/<img src="([^"]+)"/g)]
    .map((match) => decode(match[1]))
    .filter(isSafeImageUrl);

  return imgUrls.length > 4 ? imgUrls.slice(0, 4) : imgUrls;
}

function formatDiscordMessages(posts) {
  return posts.slice(0, 10).map((post, index) => {
    const safeContentHtml = toSafeContentHtml(post.content_html);
    const description = safeContentHtml.split('<br>')[0];
    const images = extractImages(safeContentHtml);

    const embeds = [{
      title: `${index + 1}. ${post.title}`,
      description,
      url: post.url,
      timestamp: post.date_published,
      ...(images[0] ? { image: { url: images[0] } } : {})
    }];

    images.slice(1).forEach((image) => {
      embeds.push({ image: { url: image } });
    });

    return embeds;
  });
}

export async function sendToDiscord(embeds) {
  if (!Array.isArray(embeds)) {
    throw new BusinessValidationError('Invalid embeds payload: expected array.');
  }

  const forumId = await getDiscordThreadId();
  const webhookUrl = `${DISCORD_DAILY_WEBHOOK_URL}?thread_id=${encodeURIComponent(forumId)}`;

  for (const embedSet of embeds) {
    const payload = { embeds: embedSet };
    await postDiscordOrThrow({
      webhookUrl,
      payload,
      jobName: 'getPopularProducts:postDiscordOrThrow'
    });
  }
}

export async function handleError(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return;
  }

  const errorMessage = errors.map((err) => sanitizeErrorMessage(err?.message)).join(' | ');
  const content = truncateForDiscord(`【Daily ProductHunt Top 10】Errors occurred: ${errorMessage}`);

  await postDiscordOrThrow({
    webhookUrl: ERROR_WEBHOOK_URL,
    payload: { content },
    jobName: 'getPopularProducts:errorWebhook'
  });
}

export async function main() {
  const errors = createErrorArray();
  let caughtError;

  try {
    const posts = await fetchProductHuntData();
    const discordMessages = formatDiscordMessages(posts);
    await sendToDiscord(discordMessages);
  } catch (error) {
    errors.addError(error);
    caughtError = error;
  }

  try {
    await handleError(errors.getErrors());
  } catch (notifyError) {
    if (!caughtError) {
      throw notifyError;
    }

    caughtError.cause = notifyError;
  }

  if (caughtError && !(caughtError instanceof BusinessValidationError)) {
    throw caughtError;
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    console.error('[getPopularProducts] Fatal error', sanitizeErrorMessage(error?.message));
    process.exitCode = 1;
  });
}
