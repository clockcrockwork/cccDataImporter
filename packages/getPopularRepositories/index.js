import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode } from 'html-entities';
import { fetchWithRetry, postDiscordOrThrow } from '../common/httpClient.js';
import { handleError, createErrorArray } from '../common/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_DAILY_TABLE_NAME = process.env.SUPABASE_DAILY_TABLE_NAME;
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const GIT_REPOSITORY_FEED_URL = process.env.GIT_REPOSITORY_FEED_URL;
const DISCORD_DAILY_WEBHOOK_URL = process.env.DISCORD_DAILY_WEBHOOK_URL;
const MIN_SUCCESS_CATEGORIES = 5;
const DISCORD_EMBED_TEXT_MAX_LENGTH = 4000;

if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_DAILY_TABLE_NAME || !ERROR_WEBHOOK_URL || !GIT_REPOSITORY_FEED_URL || !DISCORD_DAILY_WEBHOOK_URL) {
  throw new Error('Missing required environment variables.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildDiscordWebhookUrl(baseUrl, forumId) {
  const trimmedForumId = String(forumId).trim();

  if (!/^\d+$/.test(trimmedForumId)) {
    throw new Error('BusinessError: invalid Discord thread id');
  }

  const webhookUrl = new URL(baseUrl);
  webhookUrl.searchParams.set('thread_id', trimmedForumId);
  return webhookUrl.toString();
}

function sanitizeDiscordText(value) {
  return String(value)
    .replaceAll('@', '@\u200b')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DISCORD_EMBED_TEXT_MAX_LENGTH);
}

function isValidPost(post) {
  return isNonEmptyString(post?.title)
    && isNonEmptyString(post?.url)
    && isNonEmptyString(post?.content_html);
}

function normalizePosts(posts) {
  return posts
    .filter((post) => isValidPost(post))
    .map((post) => ({
      ...post,
      title: sanitizeDiscordText(post.title),
      url: String(post.url).trim(),
      content_html: String(post.content_html)
    }));
}

async function getDiscordThreadId() {
  const { data, error } = await supabase
    .from(SUPABASE_DAILY_TABLE_NAME)
    .select('forum_id');

  if (error) {
    throw error;
  }

  const forumId = data?.[0]?.forum_id;

  if (!isNonEmptyString(forumId)) {
    throw new Error('BusinessError: missing Discord thread id');
  }

  return forumId;
}

export async function fetchGitHubTrends({ fetchWithRetryImpl = fetchWithRetry, logImpl = console.log } = {}) {
  const languages = [
    'javascript',
    'css',
    'astro',
    'dart',
    'dockerfile',
    'haskell',
    'json',
    'typescript',
    'kotlin',
    'html',
    'python',
    'rich-text-format',
    'rust',
    'scala',
    'scheme',
    'smarty',
    'svg',
    'swift',
    'markdown',
    'tex',
    'vue',
    'php'
  ];

  const urls = [...new Set(languages)].map((language) => `${GIT_REPOSITORY_FEED_URL}/daily/${language}/en?format=json`);

  const responses = await Promise.allSettled(
    urls.map(async (url) => {
      const response = await fetchWithRetryImpl(url, {}, { jobName: 'getPopularRepositories:fetchGitHubTrends' });
      const data = await response.json();
      if (!Array.isArray(data?.items)) {
        throw new Error('BusinessError: invalid feed payload');
      }

      return data.items;
    })
  );

  const successCount = responses.filter((response) => response.status === 'fulfilled').length;
  const failureCount = responses.length - successCount;
  logImpl(`[getPopularRepositories] successCount=${successCount}, failureCount=${failureCount}`);

  if (successCount < MIN_SUCCESS_CATEGORIES) {
    throw new Error(`BusinessError: insufficient successful categories (${successCount}/${responses.length})`);
  }

  return responses
    .filter((response) => response.status === 'fulfilled')
    .flatMap((response) => response.value);
}

function extractImages(contentHtml) {
  const safeHtml = typeof contentHtml === 'string' ? contentHtml : '';
  const imgUrls = [...safeHtml.matchAll(/<img src="([^"]+)"/g)].map((match) => decode(match[1]));
  return imgUrls.length > 4 ? imgUrls.slice(0, 4) : imgUrls;
}

function formatDiscordMessages(posts) {
  return posts.slice(0, 10).map((post, index) => {
    const sections = (post.content_html ?? '').split('<br>');
    const description = sections[0]?.startsWith('<img') ? decode(sections[1] ?? '') : decode(sections[0] ?? '');
    const images = extractImages(post.content_html);

    return [{
      title: `${index + 1}. ${post.title}`,
      description: sanitizeDiscordText(description),
      url: post.url,
      ...(images[0] ? { image: { url: images[0] } } : {})
    }];
  });
}

export async function sendToDiscord(embeds, { getDiscordThreadIdImpl = getDiscordThreadId, postDiscordOrThrowImpl = postDiscordOrThrow } = {}) {
  const forumId = await getDiscordThreadIdImpl();
  const webhookUrl = buildDiscordWebhookUrl(DISCORD_DAILY_WEBHOOK_URL, forumId);

  for (const embedSet of embeds) {
    await postDiscordOrThrowImpl({
      webhookUrl,
      payload: { embeds: embedSet },
      jobName: 'getPopularRepositories:postDiscordOrThrow'
    });
  }
}

async function defaultHandleError(errors) {
  await handleError({
    errors,
    label: 'Daily GitHub Trending Repositories',
    webhookUrl: ERROR_WEBHOOK_URL,
    jobName: 'getPopularRepositories:errorWebhook'
  });
}

export async function main({ fetchGitHubTrendsImpl = fetchGitHubTrends, sendToDiscordImpl = sendToDiscord, handleErrorImpl = defaultHandleError } = {}) {
  const errors = createErrorArray();

  try {
    const posts = await fetchGitHubTrendsImpl();
    const normalizedPosts = normalizePosts(posts);

    if (normalizedPosts.length === 0) {
      throw new Error('BusinessError: no valid posts after category aggregation');
    }

    const discordMessages = formatDiscordMessages(normalizedPosts);
    await sendToDiscordImpl(discordMessages);
  } catch (error) {
    errors.addError(error);
  } finally {
    await handleErrorImpl(errors.getErrors());
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    console.error('[getPopularRepositories] Fatal error:', error?.message);
    process.exitCode = 1;
  });
}
