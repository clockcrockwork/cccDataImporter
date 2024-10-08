
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { decode } from 'html-entities';
import fetch from 'node-fetch';
import { pipeline } from 'stream';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

const timezone = 'Asia/Tokyo';
const processedUrls = new Set();
const streamPipeline = promisify(pipeline);

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

async function getRssFeeds() {
    const { data, error } = await supabase
        .from(SUPABASE_FEED_TABLE_NAME)
        .select('*')
        .eq('feed_type', SUPABASE_FEED_TYPE_X);

    if (error) {
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
    try 
    {
        const feed = await fetch(feedUrl);
        const feedData = await feed.json();
        
        const newArticles = feedData.items.filter(item => {
            const itemDate = DateTime.fromISO(item.date_published, { zone: 'utc' }).setZone(timezone);
            return itemDate > lastRetrieved;
          });
        return newArticles;
    }
    catch (error) {
        console.error('Error checking for new articles:', error);
        return [];
    }
}


async function notifyDiscord(webhookUrl, articles, webhookType, feedType) {
    const payloads = [];

    if (feedType === SUPABASE_FEED_TYPE_X) {
        for (let i = 0; i < articles.length; i += 15) {
            const batch = articles.slice(i, i + 15);
            const content = batch.map(article => article.url).join('\n');
            payloads.push({ content });
        }
    } else {
        articles.forEach(article => {
            payloads.push({
                embeds: [{
                    title: article.title,
                    description: article.contentSnippet,
                    url: article.url,
                    timestamp: article.date_published.toFormat('yyyy-MM-dd\'T\'HH:mm:ssZZ'),
                }]
            });
        });
    }

    for (let i = 0; i < payloads.length; i++) {
        const payload = payloads[i];
        const url = webhookType === 'thread-normal'
            ? `${FEED_PARENT_WEBHOOK_URL}?thread_id=${webhookUrl}`
            : webhookUrl;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Failed to notify Discord: ${response.statusText}`);
            }

            await response.json();
            console.log('Successfully notified Discord');
        } catch (error) {
            console.error(`Error notifying Discord: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}


  
async function processImage(imageUrl, imageName) {
    imageUrl = decode(imageUrl);
    if (processedUrls.has(imageUrl)) {
        return;
    }
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
            console.error(`HTTP error! status: ${response.status}`);
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            console.error('The URL does not point to a valid image');
            throw new Error('The URL does not point to a valid image');
        }
        const imageBuffer = await response.buffer();
        const processedImageBuffer = await sharp(imageBuffer)
            .resize(400)
            .png({ quality: 60, compressionLevel: 9 })
            .toBuffer();

        const { data, error } = await supabase.storage
            .from(SUPABASE_STORAGE_BUCKET_NAME)
            .upload(`${SUPABASE_STORAGE_FOLDER_NAME}/${imageName}.png`, processedImageBuffer, {
                cacheControl: '31536000',
                upsert: true,
                contentType: 'image/png'
            });
        if (error) {
            console.error('Error uploading image:', error);
            throw error;
        }

        processedUrls.add(imageUrl);
    } catch (error) {
        console.error('Error processing image:', error);
    }
}

async function processFeeds(feeds, concurrencyLimit = 5) {
  const errors = new Set();
  const results = [];

  for (let i = 0; i < feeds.length; i += concurrencyLimit) {
    const feedBatch = feeds.slice(i, i + concurrencyLimit);
    const feedPromises = feedBatch.map(feed => processFeed(feed, errors));
    const batchResults = await Promise.allSettled(feedPromises);

    batchResults.filter(result => result.status === 'rejected').forEach(result => errors.add(result.reason));
    results.push(...batchResults.filter(result => result.status === 'fulfilled').map(result => result.value));
  }

  return results;
}

async function processFeed(feed, errors) {
    try {
        const lastRetrieved = DateTime.fromISO(feed.last_retrieved, { zone: 'utc' }).setZone(timezone) || DateTime.fromISO('1970-01-01T00:00:00Z', { zone: 'utc' }).setZone(timezone);
        const newArticles = await checkForNewArticles(feed.url, lastRetrieved);
        if (newArticles.length === 0) return { feedId: feed.id, updates: [], notifications: [] };
        
        if (feed['hook_type'] === 'thread-normal') {
            const articlesWithImages = newArticles.filter(article => {
                const imgMatch = article.content_html?.match(/<img[^>]+src="([^">]+)"/);
                const imageUrl = imgMatch ? imgMatch[1] : null;
                return imageUrl !== null;
            });
            if (articlesWithImages.length > 0) {
                const latestArticleWithImage = articlesWithImages.reduce((latest, article) => {
                    const articleDate = DateTime.fromISO(article.date_published, { zone: 'utc' }).setZone(timezone);
                    const latestDate = DateTime.fromISO(latest.date_published, { zone: 'utc' }).setZone(timezone);
                    console.log(`articleDate: ${articleDate} / latestDate: ${latestDate}`);
                    return articleDate > latestDate ? article : latest;
                }, articlesWithImages[0]);
                if (latestArticleWithImage) {
                    const imgMatch = latestArticleWithImage.content_html.match(/<img[^>]+src="([^">]+)"/);
                    const imageUrl = imgMatch ? imgMatch[1] : null;

                    if (imageUrl) {
                        await processImage(imageUrl, feed['webhook']);
                    }
                }
            }
        }

        const updates = newArticles.map(article => ({ id: feed.id, 'last_retrieved': article.date_published }));
        const notifications = newArticles.map(article => ({ webhookUrl: feed['webhook'], article, webhookType: feed['hook_type'], feedType: feed['feed_type'] }));
        return {
            feedId: feed.id,
            updates: updates,
            notifications: notifications
        };
    } catch (error) {
        errors.addError(error);
        return { feedId: feed.id, updates: [], notifications: [] };
    }
}


async function handleError(errors) {
    if (errors.length > 0) {
        const errorMessage = errors.map(err => err.message).join('\n');
        await fetch(ERROR_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `【fetch RSS】Errors occurred: ${errorMessage}` })
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
        throw error;
    }
};

async function main() {
    const errors = createErrorArray();
    const currentDateTime = DateTime.now().setZone(timezone);

    try {
        const accessToken = await authenticateUser();
        const feeds = await getRssFeeds();
        const results = await processFeeds(feeds);

        const updates = results.flatMap(result => result.updates);
        const notifications = results.flatMap(result => result.notifications).reverse();
        // 現在の日時で更新
        if (updates.length > 0) {
            const currentDateTimeStr = currentDateTime.toFormat('yyyy-MM-dd\'T\'HH:mm:ssZZ');
            const feedMap = new Map(feeds.map(feed => [feed.id, feed]));

            const selectMap = updates.reduce((acc, update) => {
                const existing = acc.find(item => item.id === update.id);
                if (!existing) {
                    acc.push(update);
                }
                return acc;
            }, []);

            const latestUpdates = selectMap.map(update => {
                const fullFeedData = feedMap.get(update.id);
                if (fullFeedData) {
                    return { ...fullFeedData, 'last_retrieved': currentDateTime };
                } else {
                    console.error('Full feed data not found for update id:', update.id);
                }
            });

            const { error } = await supabase.from(SUPABASE_FEED_TABLE_NAME).upsert(latestUpdates, { onConflict: 'id' }).select();
            if (error) {
                throw error;
            }
        }

        if (notifications.length > 0) {
            const groupedNotifications = notifications.reduce((acc, { webhookUrl, article, webhookType, feedType }) => {
                if (!acc[webhookUrl]) acc[webhookUrl] = [];
                acc[webhookUrl].push({ article, webhookType, feedType });
                return acc;
            }, {});
            const notificationResults = await Promise.allSettled(Object.entries(groupedNotifications).map(([webhookUrl, articles]) => notifyDiscord(webhookUrl, articles.map(({ article }) => article), articles[0].webhookType, articles[0].feedType)));
            const failedNotifications = notificationResults.filter(result => result.status === 'rejected').map(result => result.status === 'rejected' ? result.reason : null);
            if (failedNotifications.length > 0) {
                throw new Error(`Failed notifications: ${failedNotifications.map(err => err.message).join('\n')}`);
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
