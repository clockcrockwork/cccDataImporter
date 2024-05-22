const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const feedparser = require('feedparser-promised');
const htmlToText = require('html-to-text');
const { JSDOM } = require('jsdom');
const { DateTime } = require('luxon');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ALICE_DISCORD_WEBHOOK_URL = process.env.ALICE_DISCORD_WEBHOOK_URL;
const ERROR_DISCORD_WEBHOOK_URL = process.env.ERROR_DISCORD_WEBHOOK_URL;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const timezone = 'Asia/Tokyo';

const sendErrorToDiscord = async (errorMessage) => {
  try {
    await axios.post(ERROR_DISCORD_WEBHOOK_URL, {
      content: `【ALICE Channel】Error occurred: ${errorMessage}`
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Failed to send error message to Discord:', error.response?.status, error.response?.data);
  }
};

const fetchFeeds = async () => {
  try {
    const { data, error } = await supabase
      .from('rss_feeds')
      .select('*')
      .eq('feed_type', 'alice');

    if (error) throw error;
    return data;
  } catch (error) {
    await sendErrorToDiscord(`Error fetching feeds: ${error.message}`);
    return [];
  }
};

const checkAndUpdateFeeds = async (feeds) => {
  let updatesFound = false;

  try {
    for (const feed of feeds) {
      const parsedFeed = await feedparser.parse({ uri: feed.url });

      const latestPubdate = DateTime.fromRFC2822(parsedFeed[0].pubdate).setZone(timezone);
      const lastRetrieved = feed.last_retrieved ? DateTime.fromISO(feed.last_retrieved).setZone(timezone) : null;

      if (!lastRetrieved || latestPubdate > lastRetrieved) {
        const latestPubdateUtc = latestPubdate.setZone('UTC').toISO();

        const { data, error } = await supabase
          .from('rss_feeds')
          .upsert({
            id: feed.id,
            feed_type: feed.feed_type,
            name: feed.name,
            url: feed.url,
            webhook: feed.webhook,
            hook_type: feed.hook_type,
            notes: feed.notes,
            last_retrieved: latestPubdateUtc
          });

        if (error) throw error;
        updatesFound = true;
        await postToDiscord(feed, parsedFeed, lastRetrieved);
      }
    }

    if (!updatesFound) {
      await postUnsplashImageToDiscord(ALICE_DISCORD_WEBHOOK_URL);
    }
  } catch (error) {
    await sendErrorToDiscord(error.message);
  }
};

const convertHtmlToMarkdown = (htmlContent) => {
  return htmlToText.fromString(htmlContent, {
    wordwrap: 130,
    linkHrefBaseUrl: ''
  });
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
      await axios.post(feed.webhook, {
        embeds: [embed]
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      await sendErrorToDiscord(`Error posting to Discord: ${error.message}`);
    }
  }
};

const postUnsplashImageToDiscord = async (webhook) => {
  try {
    const response = await axios.get('https://source.unsplash.com/random?alice-in-wonderland');
    if (response.status !== 200) throw new Error(`Failed to fetch Unsplash image: ${response.status}`);

    const embed = {
      image: { url: response.request.res.responseUrl },
      footer: { text: 'Image Source: Unsplash' }
    };

    const discordResponse = await axios.post(webhook, {
      embeds: [embed]
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (discordResponse.status !== 204) {
      throw new Error(`Failed to send message: ${discordResponse.status}`);
    }
  } catch (error) {
    await sendErrorToDiscord(`Error fetching or posting Unsplash image: ${error.message}`);
  }
};

(async () => {
  const feeds = await fetchFeeds();
  await checkAndUpdateFeeds(feeds);
})();