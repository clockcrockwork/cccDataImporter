import { createClient } from '@supabase/supabase-js';
import Parser from 'rss-parser';
import fetch from 'node-fetch';
import { createWriteStream, unlink } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import sharp from 'sharp';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const table = process.env.SUPABASE_FEED_TABLE_NAME;
const feedtype = process.env.SUPABASE_FEED_TYPE_X;
const parser = new Parser();
const pipelineAsync = promisify(pipeline);

async function getRssFeeds() {
    const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq('feed-type', feedtype);

    if (error) {
        console.error('Error fetching RSS feeds:', error);
        throw error;
    }

    return data;
}

async function checkForNewArticles(feedUrl, lastRetrieved) {
    const feed = await parser.parseURL(feedUrl);
    const newArticles = feed.items.filter(item => new Date(item.pubDate) > new Date(lastRetrieved));

    return newArticles;
}

async function notifyDiscord(webhookUrl, article, webhookType, threadId = null) {
    const payload = {
        content: article.link
    };

    if (webhookType === 'thread') {
        webhookUrl = `${process.env.FEED_PARENT_WEBHOOK_URL}?thread_id=${threadId}`;
    }

    await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

async function handleError(error) {
    const errorWebhookUrl = process.env.ERROR_WEBHOOK_URL;
    const githubToken = process.env.GITHUB_TOKEN;
    const githubRepo = process.env.GITHUB_REPO;

    const sanitizedError = {
        message: error.message.replace(/https?:\/\/\S+/g, '[REDACTED URL]').replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, '[REDACTED ID]'),
        stack: error.stack.replace(/https?:\/\/\S+/g, '[REDACTED URL]').replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, '[REDACTED ID]')
    };

    await fetch(errorWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `Error: ${sanitizedError.message}` })
    });

    await fetch(
        `https://api.github.com/repos/${githubRepo}/issues`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `token ${githubToken}`
            },
            body: JSON.stringify({
                title: `RSS Feed Error: ${sanitizedError.message}`,
                body: sanitizedError.stack,
            })
        }
    );
}

async function processImage(imageUrl, threadId) {
    const response = await fetch(imageUrl);
    const tempImagePath = `/tmp/${threadId}`;

    await pipelineAsync(response.body, createWriteStream(tempImagePath));

    const image = sharp(tempImagePath);
    const metadata = await image.metadata();

    if (metadata.format !== 'png') {
        await image.png().toFile(`${tempImagePath}.png`);
        await unlink(tempImagePath, (err) => {
            if (err) console.error(`Failed to delete temp file: ${err}`);
        });
    }

    await supabase.storage
        .from('FeedThumbs')
        .upload(`${threadId}.png`, createReadStream(`${tempImagePath}.png`), {
            upsert: true
        });

    await unlink(`${tempImagePath}.png`, (err) => {
        if (err) console.error(`Failed to delete temp file: ${err}`);
    });
}

async function main() {
    try {
        const feeds = await getRssFeeds();

        for (const feed of feeds) {
            const newArticles = await checkForNewArticles(feed.url, feed['last-retrieved']);
            for (const article of newArticles) {
                await notifyDiscord(feed['webhook-url'], article, feed['webhook-type'], feed.id);
                await supabase
                    .from(table)
                    .update({ 'last-retrieved': article.pubDate })
                    .eq('id', feed.id);

                if (feed['webhook-type'] === 'thread') {
                    const imageUrl = article.enclosure?.url || article.content?.match(/<img[^>]+src="([^">]+)"/)?.[1];
                    if (imageUrl) {
                        await processImage(imageUrl, feed.id);
                    }
                }
            }
        }

        console.log('RSS Fetch completed');
    } catch (error) {
        await handleError(error);
    }
}

main();
