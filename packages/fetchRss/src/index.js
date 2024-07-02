import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { parse, format, tzDate, isAfter } from "@formkit/tempo";
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { decode } from 'html-entities';
import fetch from 'node-fetch';
// import { pipeline } from 'stream/promises';
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
            const itemDate = parseDate(item.date_published);
            return itemDate > parseDate(lastRetrieved);
          });
        return newArticles;
    }
    catch (error) {
        console.error('Error checking for new articles:', error);
        return [];
    }
}


async function notifyDiscord(webhookUrl, articles, webhookType, feedType) {
    console.log(`Notifying Discord for ${articles.length} articles`);

    const payloads = articles.map(article => {
        if (feedType === SUPABASE_FEED_TYPE_X) {
            return {
                content: article.url
            };
        } else {
            return {
                embeds: [{
                    title: article.title,
                    description: article.contentSnippet,
                    url: article.url,
                    timestamp: format(tzDate(article.date_published, 'UTC'), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: 'UTC' }),
                }]
            };
        }
    });

    for (let i = 0; i < payloads.length; i += 10) {
        const batch = payloads.slice(i, i + 10);

        const requests = batch.map(payload => {
            const url = webhookType === 'thread-normal'
                ? `${FEED_PARENT_WEBHOOK_URL}?thread_id=${webhookUrl}`
                : webhookUrl;

            console.log(`Sending notification to Discord: ${url}`);
            console.log(`Payload: ${JSON.stringify(payload)}`);

            return fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to notify Discord: ${response.statusText}`);
                }
                return response.json().catch(() => {
                    throw new Error('Failed to parse JSON response');
                });
            }).then(responseData => {
                console.log(`Notification successful: ${JSON.stringify(responseData)}`);
            }).catch(error => {
                console.error(`Error notifying Discord: ${error.message}`);
            });
        });

        await Promise.all(requests);

        // 10件ごとに1秒の遅延を追加
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
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
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
        const lastRetrieved = feed.last_retrieved ? tzDate(feed.last_retrieved, timezone) : null;

        const newArticles = await checkForNewArticles(feed.url, lastRetrieved);
        if (newArticles.length === 0) return { feedId: feed.id, updates: [], notifications: [] };
        
        if (feed['hook_type'] === 'thread-normal') {

            const articlesWithImages = newArticles.filter(article => {
                const imgMatch = article.content_html?.match(/<img[^>]+src="([^">]+)"/);
                const imageUrl = imgMatch ? imgMatch[1] : null;
                return imageUrl !== null;
            });

            console.log(`Found ${articlesWithImages.length} articles with images for feed: ${feed.id}`);
        
            if (articlesWithImages.length > 0) {
                
                const latestArticleWithImage = articlesWithImages.reduce((latest, article) => 
                    parseDate(article.date_published) > parseDate(latest.date_published) ? article : latest, articlesWithImages[0]);
            
                const imageUrl = latestArticleWithImage.content_html.match(/<img[^>]+src="([^">]+)"/)[1];
            
                if (imageUrl) {
                    await processImage(imageUrl, feed['webhook']);
                }
            }
        
        }

        return {
            feedId: feed.id,
            updates: newArticles.map(article => ({ id: feed.id, 'last_retrieved': article.date_published })),
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
        console.log(errorMessage);
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

const parseDate = (dateString, timezone = 'Asia/Tokyo') => {
    try {
        dateString = String(dateString).replace(/\s*\([^)]*\)/, '');

        let parsedDate = new Date(dateString);
        if (isNaN(parsedDate.getTime())) {
            const formats = [
                "MMM, dd MMM YYYY HH:mm:ss GMT",
                "YYYY-MM-dd'T'HH:mm:ssZZ",
                "ddd, DD MMM YYYY HH:mm:ss",
                "MMM MMM dd YYYY HH:mm:ss GMTZZ",
                "MMM, dd MMM YYYY HH:mm:ss GMTZZ",
                "MMM MMM dd YYYY HH:mm:ss GMTZZ"
            ];
            
            for (let formatString of formats) {
                try {
                    parsedDate = parse(dateString, formatString);
                    break;
                } catch (error) {
                    continue;
                }
            }
        }
        if (isNaN(parsedDate.getTime())) {
            throw new Error("Unsupported date format");
        }
        const localTime = tzDate(parsedDate, timezone);
        const formattedDate = format({
            date: localTime,
            format: "YYYY-M-DTHH:mm:ssZZ",
            timezone: timezone
        });
        return formattedDate;
    } catch (error) {
        console.error('Invalid date format:', error.message);
        return null;
    }
};
async function main() {
    const errors = createErrorArray();
    const currentDateTime = new Date(); // 現在の日時を取得

    try {
        const accessToken = await authenticateUser();
        const feeds = await getRssFeeds();
        const results = await processFeeds(feeds);

        const updates = results.flatMap(result => result.updates);
        const notifications = results.flatMap(result => result.notifications);
        // 現在の日時で更新
        if (updates.length > 0) {
            const currentDateTimeStr = parseDate(currentDateTime);
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
                    return { ...fullFeedData, 'last_retrieved': currentDateTimeStr };
                } else {
                    console.error('Full feed data not found for update id:', update.id);
                }
            });

            console.log(`step: latestUpdates, latestUpdates: ${latestUpdates.length}`);
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
