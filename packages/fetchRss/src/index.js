import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import Parser from 'rss-parser';
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
const parser = new Parser();
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
                    timestamp: format(tzDate(article.pubDate, 'UTC'), "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone: 'UTC' }),
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
  // キャッシュチェック
  if (processedUrls.has(imageUrl)) {
      console.log(`Image already processed: ${imageUrl}`);
      return;
  }

  const startTime = Date.now();
  console.log('Processing image:', imageUrl);

  try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const transform = sharp()
          .resize(400)
          .png({ quality: 60, compressionLevel: 9 });

      const processedImageBuffer = await pipeline(
          response.body,
          transform
      );

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

      const endTime = Date.now();
      console.log(`Image processed and uploaded successfully in ${endTime - startTime}ms:`, data);
  } catch (error) {
      console.error('Error processing image:', error);
      throw error;
  }
}

async function processFeed(feed, errors) {
    const startTime = Date.now();
    try {
        const lastRetrieved = feed.last_retrieved ? tzDate(feed.last_retrieved, timezone) : null;

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
const parseDate = (dateString) => {
    try {
        dateString = String(dateString);

        // Remove parentheses and their contents
        dateString = dateString.replace(/\s*\([^)]*\)/, '');
        const formats = [
            "EEE, dd MMM yyyy HH:mm:ss 'GMT'",
            "yyyy-MM-dd HH:mm:ssXXX",
            "ddd, DD MMM YYYY HH:mm:ss",
            "EEE MMM dd yyyy HH:mm:ss 'GMT'XXX",
            "EEE, dd MMM yyyy HH:mm:ss 'GMT'XXX",
            "EEE MMM dd yyyy HH:mm:ss 'GMT'XXXXX"
        ];

        let parsedDate;
        for (let formatString of formats) {
            try {
                parsedDate = parse(dateString, formatString, { timezone: "UTC" });
                break;
            } catch (error) {
                continue;
            }
        }

        if (!parsedDate) {
            parsedDate = new Date(dateString);
            if (isNaN(parsedDate.getTime())) {
                throw new Error("Unsupported date format");
            }
        }

        const localTime = tzDate(parsedDate, timezone);
        return format(localTime, "yyyy-MM-dd HH:mm:ssXXX");
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
        const results = await Promise.allSettled(feeds.map(feed => processFeed(feed, errors)));
        const successfulResults = results.filter(result => result.status === 'fulfilled').map(result => result.value);

        const updates = successfulResults.flatMap(result => result.updates);
        const notifications = successfulResults.flatMap(result => result.notifications);
        // 現在の日時で更新
        if (updates.length > 0) {
            const currentDateTimeStr = format({
                date: currentDateTime,
                format: "ddd, DD MMM YYYY HH:mm:ss ZZ"
            })
            const feedMap = new Map(feeds.map(feed => [feed.id, feed]));

            // updateのあるfeedのみidの重複を除いて取得
            const selectMap = updates.reduce((acc, update) => {
                const existing = acc.find(item => item.id === update.id);
                if (!existing) {
                    acc.push(update);
                }
                return acc;
            }, []);

            // updateのあるfeedをfeedMapから取得し、last_retrievedを更新
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
