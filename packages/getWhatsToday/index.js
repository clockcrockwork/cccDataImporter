import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRetry, postDiscordOrThrow, createErrorArray } from '../common/httpClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_DAILY_TABLE_NAME = process.env.SUPABASE_DAILY_TABLE_NAME;
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const DISCORD_DAILY_WEBHOOK_URL = process.env.DISCORD_DAILY_WEBHOOK_URL;
const DIFY_WORKFLOW_URL = process.env.DIFY_WORKFLOW_URL;
const DIFY_API_TOKEN = process.env.DIFY_API_TOKEN;
const DIFY_USER = process.env.DIFY_USER;
const DIFY_WORKFLOW_ID = process.env.DIFY_WORKFLOW_ID;

if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_DAILY_TABLE_NAME || !ERROR_WEBHOOK_URL || !DISCORD_DAILY_WEBHOOK_URL || !DIFY_WORKFLOW_URL || !DIFY_API_TOKEN || !DIFY_USER || !DIFY_WORKFLOW_ID) {
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
    throw new Error('No Discord thread ID found in daily table.');
  }

  return data[0].forum_id;
}

async function fetchWorkFlowData() {
  const url = `${DIFY_WORKFLOW_URL}/workflows/run`;
  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DIFY_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: {},
        response_mode: 'blocking',
        user: DIFY_USER
      })
    },
    { jobName: 'getWhatsToday:fetchWorkFlowData' }
  );

  const data = await response.json();

  if (data.data.workflow_id !== DIFY_WORKFLOW_ID) {
    throw new Error(`Error: Workflow ID mismatch. Expected: ${DIFY_WORKFLOW_ID}, Received: ${data.data.workflow_id}`);
  }

  return data.data.outputs.result;
}

async function sendToDiscord(comment, forumId) {
  const webhookUrl = `${DISCORD_DAILY_WEBHOOK_URL}?thread_id=${forumId}`;
  const payload = {
    embeds: [
      {
        title: '今日はなんの日？',
        description: comment,
        footer: {
          text: '自動生成によるものです、真偽は保証されません。'
        }
      }
    ]
  };

  await postDiscordOrThrow({
    webhookUrl,
    payload,
    jobName: 'getWhatsToday:postDiscordOrThrow'
  });
}

async function handleError(errors) {
  if (errors.length === 0) {
    return;
  }

  const errorMessage = errors.map((err) => err.message).join('\n');
  await postDiscordOrThrow({
    webhookUrl: ERROR_WEBHOOK_URL,
    payload: { content: `【Daily Today Wikipedia】Errors occurred: ${errorMessage}` },
    jobName: 'getWhatsToday:errorWebhook'
  });
}

async function main() {
  const errors = createErrorArray();

  try {
    const [data, forumId] = await Promise.all([fetchWorkFlowData(), getDiscordThreadId()]);
    await sendToDiscord(data, forumId);
  } catch (error) {
    errors.addError(error);
  } finally {
    await handleError(errors.getErrors());
  }
}

main().catch(console.error);
