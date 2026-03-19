import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode } from 'html-entities';
import { fetchWithRetry, postDiscordOrThrow } from '../common/httpClient.js';

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

function createErrorArray() {
  let errorArray = [];

  return {
    addError: (error) => errorArray.push(error),
    getErrors: () => errorArray
  };
}

async function getDiscordThreadId() {
  const { data, error } = await supabase
    .from(SUPABASE_DAILY_TABLE_NAME)
    .select('forum_id');

  if (error) {
    throw error;
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
  const imgUrls = [...contentHtml.matchAll(/<img src="([^"]+)"/g)].map((match) => decode(match[1]));
  return imgUrls.length > 4 ? imgUrls.slice(0, 4) : imgUrls;
}

function formatDiscordMessages(posts) {
  return posts.slice(0, 10).map((post, index) => {
    const section = post.content_html.split('<br>')[0];
    const description = section.startsWith('<img') ? decode(post.content_html.split('<br>')[1]) : decode(section);
    const images = extractImages(post.content_html);

    return [{
      title: `${index + 1}. ${post.title}`,
      description,
      url: post.url,
      image: { url: images[0] }
    }];
  });
}

async function sendToDiscord(embeds) {
  const forumId = await getDiscordThreadId();
  const webhookUrl = `${DISCORD_DAILY_WEBHOOK_URL}?thread_id=${forumId}`;

  for (const embedSet of embeds) {
    await postDiscordOrThrow({
      webhookUrl,
      payload: { embeds: embedSet },
      jobName: 'getPopularRepositories:postDiscordOrThrow'
    });
  }
}

async function handleError(errors) {
  if (errors.length === 0) {
    return;
  }

  const errorMessage = errors.map((err) => err.message).join('\n');
  console.log(errorMessage);
  await postDiscordOrThrow({
    webhookUrl: ERROR_WEBHOOK_URL,
    payload: { content: `【Daily GitHub Trending Repositories】Errors occurred: ${errorMessage}` },
    jobName: 'getPopularRepositories:errorWebhook'
  });
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
    await handleError(errors.getErrors());
  }
}

main();
