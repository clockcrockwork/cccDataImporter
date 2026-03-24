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

if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_DAILY_TABLE_NAME || !ERROR_WEBHOOK_URL || !GIT_REPOSITORY_FEED_URL || !DISCORD_DAILY_WEBHOOK_URL) {
  throw new Error('Missing required environment variables.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getDiscordThreadId() {
  const { data, error } = await supabase
    .from(SUPABASE_DAILY_TABLE_NAME)
    .select('forum_id');

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    throw new Error('No forum_id found in daily table.');
  }
  return data[0].forum_id;
}

async function fetchGitHubTrends() {
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

  const urls = [...new Set(languages)].map((language) => `${GIT_REPOSITORY_FEED_URL}/daily/${language}`);

  const responses = await Promise.allSettled(
    urls.map(async (url) => {
      const setURL = `${url}/en?format=json`;
      const response = await fetchWithRetry(setURL, {}, { jobName: 'getPopularRepositories:fetchGitHubTrends' });
      return response.json();
    })
  );

  return responses
    .filter((response) => response.status === 'fulfilled')
    .flatMap((response) => response.value.items || []);
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
      description,
      url: post.url,
      ...(images[0] ? { image: { url: images[0] } } : {})
    }];
  });
}

async function sendToDiscord(embeds) {
  const forumId = await getDiscordThreadId();
  const webhookUrl = `${DISCORD_DAILY_WEBHOOK_URL}?thread_id=${encodeURIComponent(forumId)}`;

  for (const embedSet of embeds) {
    await postDiscordOrThrow({
      webhookUrl,
      payload: { embeds: embedSet },
      jobName: 'getPopularRepositories:postDiscordOrThrow'
    });
  }
}


async function main() {
  const errors = createErrorArray();

  try {
    const posts = await fetchGitHubTrends();
    const discordMessages = formatDiscordMessages(posts);
    await sendToDiscord(discordMessages);
  } catch (error) {
    errors.addError(error);
  } finally {
    await handleError({
      errors: errors.getErrors(),
      label: 'Daily GitHub Trending Repositories',
      webhookUrl: ERROR_WEBHOOK_URL,
      jobName: 'getPopularRepositories:errorWebhook'
    });
  }
}

main().catch((error) => {
  console.error('[getPopularRepositories] Fatal error:', error?.message);
  process.exitCode = 1;
});
