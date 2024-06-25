import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
// import Parser from 'rss-parser';
import { parse, format, tzDate, isAfter } from "@formkit/tempo";
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { decode } from 'html-entities';
import fetch from 'node-fetch';
import { pipeline } from 'stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

const timezone = 'Asia/Tokyo';
// const parser = new Parser();
const processedUrls = new Set();

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
        const startTime = Date.now();
        console.log(`Checking for new articles from feed: ${feedUrl}`);
        const fetchStartTime = Date.now();
        const feed = await fetch(feedUrl);
        const feedData = await feed.json();
        const fetchEndTime = Date.now();
        console.log(`Fetching and parsing feed took ${fetchEndTime - fetchStartTime}ms`);

        const filterStartTime = Date.now();
        // const newArticles = feedData.items.filter(item => parseDate(item.date_published) > parseDate(lastRetrieved));
        const newArticles = feedData.items.filter(item => {
            const itemDate = parseDate(item.date_published);
            console.log('Item Date:', itemDate, 'Last Retrieved:', parseDate(lastRetrieved));
            console.log(`parse-before itemDate: ${item.date_published} lastRetrieved: ${lastRetrieved}`);
            return itemDate > parseDate(lastRetrieved);
          });
        const filterEndTime = Date.now();
        console.log(`Filtering new articles took ${filterEndTime - filterStartTime}ms`);

        const endTime = Date.now();
        console.log(`Total time for checking new articles: ${endTime - startTime}ms`);

        return newArticles;
    }
    catch (error) {
        console.error('Error checking for new articles:', error);
        return [];
    }
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
                    timestamp: format(tzDate(article.date_published, 'UTC'), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: 'UTC' }),
                }]
            };
        }
    });
    
    const requests = payloads.map(payload => {
        const url = webhookType === 'thread-normal'
            ? `${FEED_PARENT_WEBHOOK_URL}?thread_id=${webhookUrl}`
            : webhookUrl;
        
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    });
    await Promise.allSettled(requests);
}
  
async function processImage(imageUrl, imageName) {
    imageUrl = decode(imageUrl);
    if (processedUrls.has(imageUrl)) {
        console.log(`Image already processed: ${imageUrl}`);
        return;
    }

    const startTime = Date.now();
    console.log('Processing image:', imageUrl);

    try {
        const fetchStartTime = Date.now();
        const response = await fetch(imageUrl);
        const fetchEndTime = Date.now();
        console.log(`Fetching image took ${fetchEndTime - fetchStartTime}ms`);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || contentType.startsWith('image/') === false) {
            throw new Error('The URL does not point to a valid image');
        }

        const transformStartTime = Date.now();
        const transform = sharp()
            .resize(400)
            .png({ quality: 60, compressionLevel: 9 });

        const processedImageBuffer = await pipeline(
            response.body,
            transform
        );
        const transformEndTime = Date.now();
        console.log(`Transforming image took ${transformEndTime - transformStartTime}ms`);

        const uploadStartTime = Date.now();
        const { data, error } = await supabase.storage
            .from(SUPABASE_STORAGE_BUCKET_NAME)
            .upload(`${SUPABASE_STORAGE_FOLDER_NAME}/${imageName}.png`, processedImageBuffer, {
                cacheControl: '31536000',
                upsert: true,
                contentType: 'image/png'
            });
        const uploadEndTime = Date.now();
        console.log(`Uploading image took ${uploadEndTime - uploadStartTime}ms`);

        if (error) {
            throw error;
        }

        processedUrls.add(imageUrl);

        const endTime = Date.now();
        console.log(`Image processed and uploaded successfully in ${endTime - startTime}ms:`, data);
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
  const startTime = Date.now();
  try {
        const lastRetrieved = feed.last_retrieved ? tzDate(feed.last_retrieved, timezone) : null;

        const newArticles = await checkForNewArticles(feed.url, lastRetrieved);
        if (newArticles.length === 0) return { feedId: feed.id, updates: [], notifications: [] };
        console.log(`Found ${newArticles.length} new articles for feed: ${feed.id}`);
        const latestArticle = newArticles.reduce((latest, article) => 
            parseDate(article.date_published) > parseDate(latest.date_published) ? article : latest, newArticles[0]);

        if (feed['hook_type'] === 'thread-normal') {
            let imageUrl = latestArticle.enclosure?.url;
            if (!imageUrl) {
                const imgMatch = latestArticle.content?.match(/<img[^>]+src="([^">]+)"/);
                imageUrl = imgMatch ? imgMatch[1] : null;
            }
            if (imageUrl) {
                await processImage(imageUrl, feed['webhook']);
            } else {
                console.log(`No valid image found for feed: ${feed.id}`);
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
  finally {
      const endTime = Date.now();
      console.log(`step: processFeed, feedId: ${feed.id}, duration: ${endTime - startTime}ms`);
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


const parseForSupabase = (dateString, timezone = 'Asia/Tokyo') => {
    try {
        console.log('Input date string:', dateString);
        dateString = String(dateString).replace(/\s*\([^)]*\)/, '');
        console.log('Input date string-format:', dateString);
        
        let parsedDate = new Date(dateString);
        if (isNaN(parsedDate.getTime())) {
            const formats = [
                "EEE, dd MMM yyyy HH:mm:ss GMT",
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                "ddd, DD MMM YYYY HH:mm:ss",
                "EEE MMM dd yyyy HH:mm:ss GMTXXX",
                "EEE, dd MMM yyyy HH:mm:ss GMTXXX",
                "EEE MMM dd yyyy HH:mm:ss GMTXXXXX"
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

        console.log('parseDate-parsedDate:', parsedDate);
        
        if (isNaN(parsedDate.getTime())) {
            throw new Error("Unsupported date format");
        }

        console.log('parseDate-date:', parsedDate);
        
        const localTime = tzDate(parsedDate, timezone);
        console.log('parseDate-localTime:', localTime);
        
        const formattedDate = format({
            date: localTime,
            format: "yyyy-MM-ddTHH:mm:ssXXX",
            timezone: timezone
        });
        console.log('parseDate-Formatted date:', formattedDate);
        
        return formattedDate;
    } catch (error) {
        console.error('Invalid date format:', error.message);
        return null;
    }
};
const parseDate = (dateString, timezone = 'Asia/Tokyo') => {
    try {
        console.log('Input date string:', dateString);
        dateString = String(dateString).replace(/\s*\([^)]*\)/, '');
        console.log('Input date string-format:', dateString);
        
        let parsedDate = new Date(dateString);
        if (isNaN(parsedDate.getTime())) {
            const formats = [
                "EEE, dd MMM yyyy HH:mm:ss GMT",
                "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
                "ddd, DD MMM YYYY HH:mm:ss",
                "EEE MMM dd yyyy HH:mm:ss GMTXXX",
                "EEE, dd MMM yyyy HH:mm:ss GMTXXX",
                "EEE MMM dd yyyy HH:mm:ss GMTXXXXX"
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

        console.log('parseDate-parsedDate:', parsedDate);
        
        if (isNaN(parsedDate.getTime())) {
            throw new Error("Unsupported date format");
        }

        console.log('parseDate-date:', parsedDate);
        
        const localTime = tzDate(parsedDate, timezone);
        console.log('parseDate-localTime:', localTime);
        
        const formattedDate = format({
            date: localTime,
            format: "yyyy-MM-ddTHH:mm:ssXXX",
            timezone: timezone
        });
        console.log('parseDate-Formatted date:', formattedDate);
        
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
            const currentDateTimeStr = parseForSupabase(currentDateTime);
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
