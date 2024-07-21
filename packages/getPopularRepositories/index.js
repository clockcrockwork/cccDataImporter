import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode } from 'html-entities';
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
const GIT_REPOSITORY_FEED_URL = process.env.GIT_REPOSITORY_FEED_URL;
const DISCORD_DAILY_WEBHOOK_URL = process.env.DISCORD_DAILY_WEBHOOK_URL;

if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_DAILY_TABLE_NAME || !ERROR_WEBHOOK_URL || !GIT_REPOSITORY_FEED_URL || !DISCORD_DAILY_WEBHOOK_URL) {
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

async function fetchGitHubTrends() {
    const urls = [
        `${GIT_REPOSITORY_FEED_URL}/daily/javascript`,
        `${GIT_REPOSITORY_FEED_URL}/daily/css`,
        `${GIT_REPOSITORY_FEED_URL}/daily/fediverse`,
        `${GIT_REPOSITORY_FEED_URL}/daily/frontend`,
        `${GIT_REPOSITORY_FEED_URL}/daily/game-engine`,
        `${GIT_REPOSITORY_FEED_URL}/daily/framework`,
        `${GIT_REPOSITORY_FEED_URL}/daily/open-source`,
        `${GIT_REPOSITORY_FEED_URL}/daily/typescript`,
        `${GIT_REPOSITORY_FEED_URL}/daily/editor`,
        `${GIT_REPOSITORY_FEED_URL}/daily/html`,
        `${GIT_REPOSITORY_FEED_URL}/daily/font`,
        `${GIT_REPOSITORY_FEED_URL}/daily/emoji`,
        `${GIT_REPOSITORY_FEED_URL}/daily/database`,
        `${GIT_REPOSITORY_FEED_URL}/daily/bot`,
        `${GIT_REPOSITORY_FEED_URL}/daily/api`,
        `${GIT_REPOSITORY_FEED_URL}/daily/chrome-extension`,
        `${GIT_REPOSITORY_FEED_URL}/daily/renderless-components`,
        `${GIT_REPOSITORY_FEED_URL}/daily/wysiwyg-editor`,
        `${GIT_REPOSITORY_FEED_URL}/daily/markdown`,
        `${GIT_REPOSITORY_FEED_URL}/daily/docker`,
        `${GIT_REPOSITORY_FEED_URL}/daily/nodejs`,
        `${GIT_REPOSITORY_FEED_URL}/daily/p2p`,
        `${GIT_REPOSITORY_FEED_URL}/daily/vue`,
        `${GIT_REPOSITORY_FEED_URL}/daily/webapp`,
        `${GIT_REPOSITORY_FEED_URL}/daily/headless-cms`,
        `${GIT_REPOSITORY_FEED_URL}/daily/self-hosted`,
        `${GIT_REPOSITORY_FEED_URL}/daily/hosting`,
        `${GIT_REPOSITORY_FEED_URL}/daily/websocket`,
        `${GIT_REPOSITORY_FEED_URL}/daily/php`
    ];
    
    const responses = await Promise.all(urls.map(url => fetch(`${url}?format=json`).then(res => res.json())));
    const items = responses.flatMap(response => response.items);
    return items;
}

function extractImages(content_html) {
    const imgUrls = [...content_html.matchAll(/<img src="([^"]+)"/g)].map(match => decode(match[1]));

    if (imgUrls.length > 4) {
        return imgUrls.slice(0, 4);
    }
    return imgUrls;
}

function formatDiscordMessages(posts) {
    return posts.slice(0, 10).map((post, index) => {
        const section = post.content_html.split('<br>')[0];
        const description = section.startsWith('<img') ? decode(post.content_html.split('<br>')[1]) : decode(section);
        const images = extractImages(post.content_html);

        const embeds = [{
            title: `${index + 1}. ${post.title}`,
            description: description,
            url: post.url,
            image: { url: images[0] }
        }];

        return embeds;
    });
}

async function sendToDiscord(embeds, retryCount = 0) {
    try {
        const forumId = await getDiscordThreadId();
        const webhookUrl = `${DISCORD_DAILY_WEBHOOK_URL}?thread_id=${forumId}`;

        for (const embedSet of embeds) {
            const payload = { embeds: embedSet };
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        }
    } catch (error) {
        if ((error.message.includes('429') || error.message.includes('429')) && retryCount < 2) {
            console.log('Rate limit exceeded. Retrying in 1 second...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            await sendToDiscord(embeds, retryCount + 1);
        } else {
            throw error;
        }
    }
}

async function handleError(errors) {
    if (errors.length > 0) {
        const errorMessage = errors.map(err => err.message).join('\n');
        console.log(errorMessage);
        await fetch(ERROR_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `【Daily GitHub Trending Repositories】Errors occurred: ${errorMessage}` })
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
        await handleError(errors.getErrors());
    }
}

main();
