const { createClient } = require('@supabase/supabase-js');
const feedparser = require('feedparser-promised');
const htmlToText = require('html-to-text');
const { JSDOM } = require('jsdom');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

if (!process.env.GITHUB_ACTIONS) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ALICE_DISCORD_WEBHOOK_URL = process.env.ALICE_DISCORD_WEBHOOK_URL;
const SUPABASE_FEED_TABLE_NAME = process.env.SUPABASE_FEED_TABLE_NAME;
const SUPABASE_FEED_TYPE_ALICE = process.env.SUPABASE_FEED_TYPE_ALICE;

if (!SUPABASE_URL || !SUPABASE_KEY || !ALICE_DISCORD_WEBHOOK_URL || !SUPABASE_FEED_TABLE_NAME || !SUPABASE_FEED_TYPE_ALICE) {
  throw new Error("Missing required environment variables.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const timezone = 'Asia/Tokyo';

async function handleError(error) {
  const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
  const GH_TOKEN = process.env.GH_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;

  // エラーがオブジェクトの場合、messageとstackを取り出す
  if (error instanceof Error) {
    error = {
      message: error.message,
      stack: error.stack
    };
  }
  // エラーが文字列の場合、オブジェクトに変換する
  if (typeof error === 'string') {
    error = {
      message: error
    };
  }

  // messageとstackが文字列かどうかチェックする
  if (typeof error.message === 'string') {
    error.message = error.message.replace(/https?:\/\/\S+/g, '[REDACTED URL]').replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, '[REDACTED ID]');
  }

  if (typeof error.stack === 'string') {
    error.stack = error.stack.replace(/https?:\/\/\S+/g, '[REDACTED URL]').replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, '[REDACTED ID]');
  }

  console.log('Error:', error.message);
  await fetch(ERROR_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `Error: ${error.message}` })
  });
  // const sanitizedError = {
  //     message: error.message.replace(/https?:\/\/\S+/g, '[REDACTED URL]').replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, '[REDACTED ID]'),
  //     stack: error.stack ? error.stack.replace(/https?:\/\/\S+/g, '[REDACTED URL]').replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, '[REDACTED ID]') : 'No stack trace available'
  // };
  // await fetch(
  //     `https://api.github.com/repos/${GITHUB_REPO}/issues`,
  //     {
  //         method: 'POST',
  //         headers: {
  //             'Content-Type': 'application/json',
  //             'Authorization': `token ${GH_TOKEN}`
  //         },
  //         body: JSON.stringify({
  //             title: `ALICE Channel Error: ${sanitizedError.message}`,
  //             body: sanitizedError.stack,
  //         })
  //     }
  // );
}

const fetchFeeds = async () => {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_FEED_TABLE_NAME)
      .select('*')
      .eq('feed_type', SUPABASE_FEED_TYPE_ALICE);
    if (error) throw error;
    return data;
  } catch (error) {
    await handleError(error);
    return [];
  }
};

const checkAndUpdateFeeds = async (feeds) => {
  let updatesFound = false;

  try {
    const accessToken = await authenticateUser();
    for (const feed of feeds) {
      const parsedFeed = await feedparser.parse({ uri: feed.url });
      // 日付文字列の値をログに出力する
      const pubdateString = parsedFeed[0].pubdate;
      
      // 日付文字列を解析して適切なDateTimeオブジェクトを作成する関数
      const parseDate = (dateString) => {
        let dateTime;
        try {
          dateTime = DateTime.fromRFC2822(dateString).setZone(timezone);
        } catch (e) {
          try {
            dateTime = DateTime.fromISO(dateString).setZone(timezone);
          } catch (e) {
            handleError('Invalid date format:' + e.message);
            return null;
          }
        }
        return dateTime;
      };
      const latestPubdate = parseDate(pubdateString);
      if (!latestPubdate) {
        throw new Error(`Invalid date format: ${pubdateString}`);
      }
      const lastRetrieved = feed.last_retrieved ? DateTime.fromISO(feed.last_retrieved).setZone(timezone) : null;
      if (!lastRetrieved || latestPubdate > lastRetrieved) {
        const latestPubdateUtc = latestPubdate.setZone('UTC').toISO();
        const { data, error } = await supabase
          .from(SUPABASE_FEED_TABLE_NAME)
          .upsert({
            id: feed.id,
            feed_type: feed.feed_type,
            name: feed.name,
            url: feed.url,
            webhook: feed.webhook,
            hook_type: feed.hook_type,
            notes: feed.notes,
            last_retrieved: latestPubdateUtc
          }, { onConflict: 'id' });

        if (error) throw error;
        updatesFound = true;
        await postToDiscord(feed, parsedFeed, lastRetrieved);
      }
    }

    if (!updatesFound) {
      await postRandomImageToDiscord(ALICE_DISCORD_WEBHOOK_URL);
    }
  } catch (error) {
    await handleError(error);
  }
};

const convertHtmlToMarkdown = (htmlContent) => {
  return htmlToText.fromString(htmlContent, {
    wordwrap: 130,
    linkHrefBaseUrl: ''
  });
};
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
const postToDiscord = async (feed, entries, lastRetrieved = null) => {
  entries.reverse();
  
  for (const entry of entries) {
    const pubdate = DateTime.fromRFC2822(entry.pubdate).setZone(timezone);
    
    if (lastRetrieved && pubdate <= lastRetrieved) continue;

    const value = entry.description;
    const dom = new JSDOM(value);
    const imageElement = dom.window.document.querySelector('img');
    const imageUrl = imageElement ? imageElement.src : null;

    const embed = {
      title: entry.title,
      description: convertHtmlToMarkdown(entry.description),
      url: entry.link,
      footer: { text: feed.name },
      image: { url: imageUrl }
    };
    try {
      const response = await fetch(feed.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.status}`);
      }
    } catch (error) {
      await handleError(error);
    }
  }
};

const postRandomImageToDiscord = async (webhook) => {
  const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
  const FLICKR_API_KEY = process.env.FLICKR_API_KEY;
  
  const sources = [
    {
      url: (keyword) => {
        const encodedKeyword = encodeURIComponent(keyword);
        return `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${keyword}&image_type=all&safesearch=true&per_page=3&page=${Math.floor(Math.random() * 100) + 1}`;
      },
      parseResponse: (data) => {
        const images = data.hits;
        if (images.length === 0) throw new Error('No images found');
        const randomImage = images[Math.floor(Math.random() * images.length)];
        return randomImage.webformatURL;
      },
      footer: 'Image Source: Pixabay'
    },
    {
      url: (keyword) => {
        const encodedKeyword = encodeURIComponent(keyword);
        return `https://www.flickr.com/services/rest/?method=flickr.photos.search&api_key=${FLICKR_API_KEY}&tags=${keyword}&format=json&nojsoncallback=1&per_page=${Math.floor(Math.random() * 48) + 3}&page=${Math.floor(Math.random() * 100) + 1}`;
      },
      parseResponse: (data) => {
        const images = data.photos.photo;
        if (images.length === 0) throw new Error('No images found');
        const randomImage = images[Math.floor(Math.random() * images.length)];
        return `https://live.staticflickr.com/${randomImage.server}/${randomImage.id}_${randomImage.secret}.jpg`;
      },
      footer: 'Image Source: Flickr'
    }
  ];

  // どちらを使うかランダムに選択
  const source = sources[Math.floor(Math.random() * sources.length)];

  try {
    const response = await fetch(source.url('alice in wonderland'));
    const data = await response.json();
    const imageUrl = source.parseResponse(data);

    const embed = {
      image: { url: imageUrl },
      footer: { text: source.footer }
    };

    const discordResponse = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!discordResponse.ok) {
      throw new Error(`Failed to send message: ${discordResponse.status}`);
    }
  } catch (error) {
    handleError(error);
  }
};

(async () => {
  const feeds = await fetchFeeds();
  await checkAndUpdateFeeds(feeds);
})();
