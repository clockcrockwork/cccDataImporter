import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import Parser from 'rss-parser';
import { DateTime } from 'luxon';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, unlinkSync } from 'fs';
import Jimp from 'jimp';
import he from 'he';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

const timezone = 'Asia/Tokyo';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_FEED_TABLE_NAME = process.env.SUPABASE_FEED_TABLE_NAME;
const SUPABASE_FEED_TYPE_X = process.env.SUPABASE_FEED_TYPE_X;
const SUPABASE_STORAGE_BUCKET_NAME = process.env.SUPABASE_STORAGE_BUCKET_NAME;
const SUPABASE_STORAGE_FOLDER_NAME = process.env.SUPABASE_STORAGE_FOLDER_NAME || '';
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const FEED_PARENT_WEBHOOK_URL = process.env.FEED_PARENT_WEBHOOK_URL;
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
    const newArticles = feed.items.filter(item => parseDate(item.pubDate) > parseDate(lastRetrieved));

    return newArticles;
}

async function notifyDiscord(webhookUrl, articles, webhookType, feedType) {
    const payloads = articles.map(article => {
        if (feedType === SUPABASE_FEED_TYPE_X) {
            return {
                content: article.link
            };
        } else {
            return {
                embeds: [{
                    title: article.title,
                    description: article.contentSnippet,
                    url: article.link,
                    timestamp: new Date(article.pubDate).toISOString(),
                }]
            };
        }
    });

    const requests = payloads.map(payload => {
        const url = webhookType === 'thread-normal'
            ? `${FEED_PARENT_WEBHOOK_URL}/?thread_id=${webhookUrl}`
            : webhookUrl;

        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    });
    await Promise.all(requests);
}
  
async function processImage(imageUrl, imageName) {
    const decodedUrl = he.decode(imageUrl);
    const image = await Jimp.read(decodedUrl);
    const contentType = 'image/png';

    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);

    const { error } = await supabase.storage
        .from(SUPABASE_STORAGE_BUCKET_NAME)
        .upload(`${SUPABASE_STORAGE_FOLDER_NAME}/${imageName}.png`, buffer, {
            cacheControl: '31536000',
            upsert: true,
            contentType: contentType
        });

    if (error) {
        throw error;
    }
}
  

async function processFeed(feed, errors) {
    try {
        const lastRetrieved = feed.last_retrieved ? DateTime.fromISO(feed.last_retrieved).setZone(timezone) : null;

        const newArticles = await checkForNewArticles(feed.url, lastRetrieved);
        if (newArticles.length === 0) return { feedId: feed.id, updates: [], notifications: [] };

        const latestArticle = newArticles.reduce((latest, article) => 
            parseDate(article.pubDate) > parseDate(latest.pubDate) ? article : latest, newArticles[0]);
        
        if (feed['hook_type'] === 'thread-normal') {
            const imageUrl = latestArticle.enclosure?.url || latestArticle.content?.match(/<img[^>]+src="([^">]+)"/)?.[1];
            if (imageUrl) {
                await processImage(imageUrl, feed['webhook']);
            }
        }

        return {
            feedId: feed.id,
            updates: newArticles.map(article => ({ id: feed.id, 'last_retrieved': article.pubDate })),
            notifications: newArticles.map(article => ({ webhookUrl: feed['webhook'], article, webhookType: feed['hook_type'], feedType: feed['feed_type'] }))
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
const authenticateUser = async () => {
    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: process.env.SUPABASE_EMAIL,
            password: process.env.SUPABASE_PASSWORD
        });
        if (error) throw error;
        return data.session.access_token;
    } catch (error) {
        await handleError(`Error authenticating user: ${error.message}`);
        throw error;
    }
};
const parseDate = (dateString) => {
    let dateTime;
    try {
        dateTime = DateTime.fromRFC2822(dateString).setZone(timezone);
    } catch (e) {
        try {
            dateTime = DateTime.fromISO(dateString).setZone(timezone);
        } catch (e) {
            handleError('Invalid date format:', e.message);
            return null;
        }
    }
    return dateTime;
};
async function main() {
    const errors = createErrorArray();

    try {
        const accessToken = await authenticateUser();
        const feeds = await getRssFeeds();
        const results = await Promise.allSettled(feeds.map(feed => processFeed(feed, errors)));

        const successfulResults = results.filter(result => result.status === 'fulfilled').map(result => result.value);

        const updates = successfulResults.flatMap(result => result.updates);
        const notifications = successfulResults.flatMap(result => result.notifications);
        console.log('Updates:', updates);
        // 最新の日付で更新
        if (updates.length > 0) {
            const latestUpdates = updates.reduce((acc, update) => {
                const existing = acc.find(item => item.id === update.id);
                const fullFeedData = feeds.find(feed => feed.id === update.id);

                if (existing) {
                    if (DateTime.fromISO(update['last_retrieved']) > DateTime.fromISO(existing['last_retrieved'])) {
                        existing['last_retrieved'] = update['last_retrieved'];
                    }
                } else {
                    // fullFeedDataから必要なフィールドをすべて含める
                    acc.push({ ...fullFeedData, 'last_retrieved': update['last_retrieved'] });
                }
                return acc;
            }, []);
            console.log('Latest updates:', latestUpdates);
            const { error } = await supabase.from(SUPABASE_FEED_TABLE_NAME).upsert(latestUpdates, { onConflict: 'id' }).select();

            if (error) {
                throw error;
            }
        }

        if (notifications.length > 0) {
            const groupedNotifications = notifications.reduce((acc, { webhookUrl, article, webhookType, feedType }) => {
                if (!acc[webhookUrl]) acc[webhookUrl] = [];
                acc[webhookUrl].push({ article, webhookType });
                return acc;
            }, {});
            
            for (const [webhookUrl, articles] of Object.entries(groupedNotifications)) {
                await notifyDiscord(webhookUrl, articles.map(({ article }) => article), articles[0].webhookType, articles[0].feedType);
            }
        }
    } catch (error) {
        errors.addError(error);
    }
    finally {
        await handleError(errors.getErrors());
    }
}

main();
