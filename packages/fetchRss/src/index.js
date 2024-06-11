import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_FEED_TABLE_NAME = process.env.SUPABASE_FEED_TABLE_NAME;
const SUPABASE_FEED_TYPE_X = process.env.SUPABASE_FEED_TYPE_X;
const SUPABASE_STORAGE_BUCKET_NAME = process.env.SUPABASE_STORAGE_BUCKET_NAME;
const SUPABASE_STORAGE_FOLDER_NAME = process.env.SUPABASE_STORAGE_FOLDER_NAME || '';
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;

if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_FEED_TABLE_NAME || !SUPABASE_FEED_TYPE_X || !SUPABASE_STORAGE_BUCKET_NAME) {
    throw new Error("Missing required environment variables.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const parser = new Parser();

async function getRssFeeds() {
    const { data, error } = await supabase
        .from(SUPABASE_FEED_TABLE_NAME)
        .select('*')
        .eq('feed_type', SUPABASE_FEED_TYPE_X);

    console.log('RSS Feeds:', data);

    if (error) {
        console.error('Error fetching RSS feeds:', error);
        throw error;
    }

    return data;
}

function createErrorArray() {
    let errorArray = [];
    
    return {
        addError: (error) => errorArray.push(error),
        getErrors: () => errorArray
    };
}

async function checkForNewArticles(feedUrl, lastRetrieved) {
    const feed = await parser.parseURL(feedUrl);
    const newArticles = feed.items.filter(item => new Date(item.pubDate) > new Date(lastRetrieved));

    return newArticles;
}

async function notifyDiscord(webhookUrl, articles, webhookType, threadId = null) {
    const payloads = articles.map(article => ({
        content: article.link
    }));

    const requests = payloads.map(payload =>
        fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
    );

    await Promise.all(requests);
}

async function processImage(imageUrl, imageName) {
    const image = await Jimp.read(imageUrl);
    const tempImagePath = `/tmp/${imageName}.png`;

    await image.writeAsync(tempImagePath);

    const { error } = await supabase.storage
        .from(SUPABASE_STORAGE_BUCKET_NAME)
        .upload(`${SUPABASE_STORAGE_FOLDER_NAME}/${imageName}.png`, readFileSync(tempImagePath), {
            cacheControl: '31536000',
            upsert: true
        });

    unlinkSync(tempImagePath);

    if (error) {
        console.error('Error uploading image:', error);
        throw error;
    }
}

async function processFeed(feed, errors) {
    try {
        const newArticles = await checkForNewArticles(feed.url, feed['last-retrieved']);

        if (newArticles.length === 0) return { feedId: feed.id, updates: [], notifications: [] };

        const latestArticle = newArticles.reduce((latest, article) => 
            new Date(article.pubDate) > new Date(latest.pubDate) ? article : latest, newArticles[0]);

        if (feed['webhook-type'] === 'thread') {
            const imageUrl = latestArticle.enclosure?.url || latestArticle.content?.match(/<img[^>]+src="([^">]+)"/)?.[1];
            if (imageUrl) {
                await processImage(imageUrl, feed.id);
            }
        }

        return {
            feedId: feed.id,
            updates: newArticles.map(article => ({ id: feed.id, 'last-retrieved': article.pubDate })),
            notifications: newArticles.map(article => ({ webhookUrl: feed['webhook-url'], article, webhookType: feed['webhook-type'], threadId: feed.id }))
        };
    } catch (error) {
        errors.addError(error);
        return { feedId: feed.id, updates: [], notifications: [] };
    }
}


async function handleError(errors) {
    if (errors.length > 0) {
        const errorMessage = errors.map(err => err.message).join('\n');

        console.error('Errors:', errorMessage);

        await fetch(ERROR_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `Errors occurred: ${errorMessage}` })
        });
    }
}

async function main() {
    const errors = createErrorArray();

    try {
        const feeds = await getRssFeeds();
        const results = await Promise.allSettled(feeds.map(feed => processFeed(feed, errors)));

        const successfulResults = results.filter(result => result.status === 'fulfilled').map(result => result.value);

        const updates = successfulResults.flatMap(result => result.updates);
        const notifications = successfulResults.flatMap(result => result.notifications);

        if (updates.length > 0) {
            await supabase.from(SUPABASE_FEED_TABLE_NAME).upsert(updates);
        }

        if (notifications.length > 0) {
            const groupedNotifications = notifications.reduce((acc, { webhookUrl, article, webhookType, threadId }) => {
                if (!acc[webhookUrl]) acc[webhookUrl] = [];
                acc[webhookUrl].push({ article, webhookType, threadId });
                return acc;
            }, {});

            for (const [webhookUrl, articles] of Object.entries(groupedNotifications)) {
                await notifyDiscord(webhookUrl, articles.map(({ article }) => article), articles[0].webhookType, articles[0].threadId);
            }
        }

        console.log('RSS Fetch completed');
    } catch (error) {
        errors.addError(error);
    }

    await handleError(errors.getErrors());
}

main();
