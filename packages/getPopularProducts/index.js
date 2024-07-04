import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode } from 'html-entities';
import fetch from 'node-fetch';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_DAILY_TABLE_NAME = process.env.SUPABASE_DAILY_TABLE_NAME;
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const PRODUCTHUNT_FEED_URL = process.env.PRODUCTHUNT_FEED_URL; // 'https://rsshub.app/producthunt/today?format=json'
const DISCORD_DAILY_WEBHOOK_URL = process.env.DISCORD_DAILY_WEBHOOK_URL;

if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_DAILY_TABLE_NAME || !ERROR_WEBHOOK_URL || !PRODUCTHUNT_FEED_URL || !DISCORD_DAILY_WEBHOOK_URL) {
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

    // forum_idを1つだけ取得し返す
    return data[0].forum_id;
}

async function fetchProductHuntData() {
    const url = PRODUCTHUNT_FEED_URL;
    const response = await fetch(url);
    const data = await response.json();
    return data.items;
}

function extractImages(content_html) {
    const imgUrls = [...content_html.matchAll(/<img src="([^"]+)"/g)].map(match => match[1]);

    if (imgUrls.length > 4) {
        return imgUrls.slice(0, 4);
    }
    return imgUrls;
}

function formatDiscordMessages(posts) {
    return posts.slice(0, 10).map((post, index) => {
        const description = post.content_html.split('<br>')[0];
        const images = extractImages(post.content_html);

        const embeds = [{
            title: `${index + 1}. ${post.title}`,
            description: description,
            url: post.url,
            timestamp: post.date_published,
            image: { url: images[0] }
        }];

        images.slice(1).forEach(image => {
            embeds.push({ image: { url: image } });
        });

        return embeds;
    });
}

async function sendToDiscord(embeds) {
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
}
async function handleError(errors) {
    if (errors.length > 0) {
        const errorMessage = errors.map(err => err.message).join('\n');
        console.log(errorMessage);
        await fetch(ERROR_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `【Daily ProductHunt Top 10】Errors occurred: ${errorMessage}` })
        });
    }
}
async function main() {
    const errors = createErrorArray();
    try {
        const posts = await fetchProductHuntData();
        const discordMessages = formatDiscordMessages(posts);
        await sendToDiscord(discordMessages);
        console.log('Top 10 posts sent to Discord successfully!');
    } catch (error) {
        errors.addError(error);
    }
    finally {
        await handleError(errors.getErrors());
    }
}

main();
