import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

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
    throw new Error("Missing required environment variables.");
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

async function fetchWorkFlowData() {
    const url = `${process.env.DIFY_WORKFLOW_URL}/workflows/run`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.DIFY_API_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            "inputs": {},
            "response_mode": "blocking",
            "user": process.env.DIFY_USER
        })
    });
    if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
    }
    
    const data = await response.json();
    if (data.data.workflow_id !== process.env.DIFY_WORKFLOW_ID) {
        throw new Error(`Error: Workflow ID mismatch. Expected: ${process.env.DIFY_WORKFLOW_ID}, Received: ${data.data.workflow_id}`);
    }
    return data.data.outputs.result;
}
async function sendToDiscord(comment, forumId, retryCount = 0) {
    try {
        const webhookUrl = `${DISCORD_DAILY_WEBHOOK_URL}?thread_id=${forumId}`;

        const payload = {
            embeds: [
                {
                    title: "今日はなんの日？",
                    description: comment,
                    footer: {
                        text: '自動生成によるものです、真偽は保証されません。'
                    }
                }
            ]
        };

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

    } catch (error) {
        if ((error.message.includes('429') || error.message.includes('Rate limit')) && retryCount < 2) {
            console.log('Rate limit exceeded. Retrying in 1 second...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            await sendToDiscord(comment, forumId, retryCount + 1);
        } else {
            throw error;
        }
    }
}


async function handleError(errors) {
    if (errors.length > 0) {
        const errorMessage = errors.map(err => err.message).join('\n');
        await fetch(ERROR_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `【Daily Today Wikipedia】Errors occurred: ${errorMessage}` })
        });
    }
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