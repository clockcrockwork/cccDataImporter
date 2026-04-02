const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const rssParser = new Parser();
const htmlToText = require('html-to-text');
const { JSDOM } = require('jsdom');
const { DateTime } = require('luxon');
const path = require('path');
const net = require('net');
const { fetchWithRetry, postDiscordOrThrow } = require('../../common/httpClient.cjs');
const { handleError, toErrorMessage, sanitizeText } = require('../../common/errorHandler.cjs');

if (!process.env.GITHUB_ACTIONS) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ALICE_DISCORD_WEBHOOK_URL = process.env.ALICE_DISCORD_WEBHOOK_URL;
const SUPABASE_FEED_TABLE_NAME = process.env.SUPABASE_FEED_TABLE_NAME;
const SUPABASE_FEED_TYPE_ALICE = process.env.SUPABASE_FEED_TYPE_ALICE;

if (!SUPABASE_URL || !SUPABASE_KEY || !ALICE_DISCORD_WEBHOOK_URL || !SUPABASE_FEED_TABLE_NAME || !SUPABASE_FEED_TYPE_ALICE) {
  throw new Error('Missing required environment variables.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const timezone = 'Asia/Tokyo';

function isPrivateOrLocalAddress(hostname) {
  const normalized = (hostname || '').toLowerCase();
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized.endsWith('.local')) return true;

  const ipType = net.isIP(normalized);
  if (ipType === 4) {
    if (normalized.startsWith('10.') || normalized.startsWith('127.') || normalized.startsWith('192.168.')) return true;
    const secondOctet = Number(normalized.split('.')[1]);
    if (normalized.startsWith('172.') && secondOctet >= 16 && secondOctet <= 31) return true;
  }
  if (ipType === 6) {
    if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  }
  return false;
}

function assertSafeUrl(rawUrl, { httpsOnly = false, label }) {
  try {
    const parsed = new URL(rawUrl);
    const allowedProtocol = httpsOnly ? parsed.protocol === 'https:' : parsed.protocol === 'https:' || parsed.protocol === 'http:';
    if (!allowedProtocol) {
      throw new Error(`Unsupported protocol for ${label}`);
    }
    if (isPrivateOrLocalAddress(parsed.hostname)) {
      throw new Error(`Blocked private/local host for ${label}`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Unsafe URL for ${label}: ${sanitizeText(rawUrl)} (${toErrorMessage(error)})`);
  }
}

function parseFeedDate(dateString) {
  if (!dateString) {
    return null;
  }

  const parsers = [DateTime.fromRFC2822, DateTime.fromISO, DateTime.fromHTTP];
  for (const parser of parsers) {
    const parsed = parser(dateString, { zone: timezone });
    if (parsed.isValid) {
      return parsed;
    }
  }

  return null;
}

const aliceHandleError = (error) => handleError({
  errors: error,
  label: 'Alice Blog Check',
  webhookUrl: process.env.ERROR_WEBHOOK_URL,
  jobName: 'aliceBlogChecker:handleError'
});

const fetchFeeds = async () => {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_FEED_TABLE_NAME)
      .select('*')
      .eq('feed_type', SUPABASE_FEED_TYPE_ALICE);
    if (error) throw error;
    return data;
  } catch (error) {
    await aliceHandleError(error);
    return [];
  }
};

const checkAndUpdateFeeds = async (feeds) => {
  let updatesFound = false;

  try {
    await authenticateUser();
    for (const feed of feeds) {
      try {
        assertSafeUrl(feed.url, { httpsOnly: false, label: 'feed url' });
        const parsedFeed = await rssParser.parseURL(feed.url);
        if (!parsedFeed.items || !parsedFeed.items.length) {
          throw new Error(`Feed has no entries. url=${feed.url}`);
        }

        const latestPubdate = parseFeedDate(parsedFeed.items[0].pubDate);
        if (!latestPubdate) {
          throw new Error(`Invalid date format: ${parsedFeed.items[0].pubDate}. url=${feed.url}`);
        }

        const lastRetrieved = feed.last_retrieved ? DateTime.fromISO(feed.last_retrieved).setZone(timezone) : null;
        if (!lastRetrieved || latestPubdate > lastRetrieved) {
          const latestPubdateUtc = latestPubdate.setZone('UTC').toISO();
          const { error } = await supabase
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
          await postToDiscord(feed, parsedFeed.items, lastRetrieved);
        }
      } catch (error) {
        await aliceHandleError(`Feed processing failed for url=${feed.url}: ${toErrorMessage(error)}`);
      }
    }

    if (!updatesFound) {
      await postRandomImageToDiscord(ALICE_DISCORD_WEBHOOK_URL);
    }
  } catch (error) {
    await aliceHandleError(error);
  }
};

const convertHtmlToMarkdown = (htmlContent) => {
  return htmlToText.convert(htmlContent || '', {
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
    await aliceHandleError(`Error authenticating user: ${error.message}`);
    throw error;
  }
};

const postToDiscord = async (feed, entries, lastRetrieved = null) => {
  if (!feed.webhook) {
    await aliceHandleError(`Missing webhook for feed url=${feed.url}`);
    return;
  }
  assertSafeUrl(feed.webhook, { httpsOnly: true, label: `feed webhook url=${feed.url}` });

  const orderedEntries = [...entries].reverse();

  for (const entry of orderedEntries) {
    const pubdate = parseFeedDate(entry.pubDate);
    if (!pubdate) {
      await aliceHandleError(`Skip entry with invalid date. url=${feed.url}`);
      continue;
    }

    if (lastRetrieved && pubdate <= lastRetrieved) continue;

    const description = entry.content || entry.contentSnippet || '';
    const dom = new JSDOM(description);
    const imageElement = dom.window.document.querySelector('img');
    const imageUrl = imageElement ? imageElement.src : null;

    const embed = {
      title: entry.title,
      description: convertHtmlToMarkdown(description),
      url: entry.link,
      footer: { text: feed.name },
      image: { url: imageUrl }
    };

    try {
      await postDiscordOrThrow({
        webhookUrl: feed.webhook,
        payload: { embeds: [embed] },
        jobName: 'aliceBlogChecker:postToDiscord'
      });
    } catch (error) {
      await aliceHandleError(error);
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
        return `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${encodedKeyword}&image_type=all&pretty=true&safesearch=true&per_page=3&page=${Math.floor(Math.random() * 200) + 1}`;
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
        return `https://www.flickr.com/services/rest/?method=flickr.photos.search&api_key=${FLICKR_API_KEY}&tags=${encodedKeyword}&format=json&nojsoncallback=1&per_page=1&page=${Math.floor(Math.random() * 1000) + 1}`;
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

  const source = sources[Math.floor(Math.random() * sources.length)];

  try {
    assertSafeUrl(webhook, { httpsOnly: true, label: 'main webhook' });
    const response = await fetchWithRetry(
      source.url('alice in wonderland'),
      {},
      { jobName: 'aliceBlogChecker:postRandomImageToDiscord' }
    );
    const data = await response.json();
    const imageUrl = source.parseResponse(data);
    const embed = {
      image: { url: imageUrl },
      footer: { text: source.footer }
    };

    await postDiscordOrThrow({
      webhookUrl: webhook,
      payload: { embeds: [embed] },
      jobName: 'aliceBlogChecker:postRandomImageToDiscord'
    });
  } catch (error) {
    await aliceHandleError(error);
  }
};

module.exports = {
  parseFeedDate,
  handleError: aliceHandleError,
  fetchFeeds,
  checkAndUpdateFeeds,
  authenticateUser,
  postToDiscord,
  postRandomImageToDiscord
};

if (require.main === module) {
  (async () => {
    const feeds = await fetchFeeds();
    await checkAndUpdateFeeds(feeds);
  })();
}
