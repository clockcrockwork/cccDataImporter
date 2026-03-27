process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.ALICE_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/main';
process.env.SUPABASE_FEED_TABLE_NAME = 'feeds';
process.env.SUPABASE_FEED_TYPE_ALICE = 'alice';
process.env.SUPABASE_EMAIL = 'alice@example.com';
process.env.SUPABASE_PASSWORD = 'password';
process.env.ERROR_WEBHOOK_URL = 'https://discord.com/api/webhooks/error';

const mockParseURL = jest.fn();
const mockUpsert = jest.fn();
const mockEq = jest.fn();
const mockSelect = jest.fn();
const mockFrom = jest.fn();
const mockSignInWithPassword = jest.fn();

jest.mock('rss-parser', () => {
  return jest.fn().mockImplementation(() => ({
    parseURL: (...args) => mockParseURL(...args)
  }));
});

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: (...args) => mockFrom(...args),
    auth: {
      signInWithPassword: (...args) => mockSignInWithPassword(...args)
    }
  }))
}));

const mockFetchWithRetry = jest.fn();
const mockPostDiscordOrThrow = jest.fn();
jest.mock('../../common/httpClient.cjs', () => ({
  fetchWithRetry: (...args) => mockFetchWithRetry(...args),
  postDiscordOrThrow: (...args) => mockPostDiscordOrThrow(...args)
}));

mockFrom.mockImplementation(() => ({
  select: (...args) => mockSelect(...args),
  upsert: (...args) => mockUpsert(...args)
}));

mockSelect.mockImplementation(() => ({
  eq: (...args) => mockEq(...args)
}));

mockEq.mockResolvedValue({ data: [], error: null });
mockUpsert.mockResolvedValue({ data: {}, error: null });
mockSignInWithPassword.mockResolvedValue({
  data: { session: { access_token: 'token' } },
  error: null
});

const aliceBlogChecker = require('../src/index');

describe('aliceBlogChecker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();

    mockEq.mockResolvedValue({ data: [], error: null });
    mockUpsert.mockResolvedValue({ data: {}, error: null });
    mockSignInWithPassword.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null
    });
  });

  it('parseFeedDate supports RFC2822 and ISO', () => {
    const rfc = aliceBlogChecker.parseFeedDate('Wed, 02 Oct 2002 13:00:00 GMT');
    const iso = aliceBlogChecker.parseFeedDate('2002-10-02T13:00:00.000Z');
    const invalid = aliceBlogChecker.parseFeedDate('not-a-date');

    expect(rfc).not.toBeNull();
    expect(iso).not.toBeNull();
    expect(invalid).toBeNull();
  });

  it('does not call fetch directly and uses httpClient helpers', async () => {
    mockFetchWithRetry.mockResolvedValue({
      json: async () => ({ hits: [{ webformatURL: 'https://img.example/test.jpg' }] })
    });

    await aliceBlogChecker.postRandomImageToDiscord('https://discord.com/api/webhooks/target');

    expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
    expect(mockPostDiscordOrThrow).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('continues processing when one feed fails', async () => {
    const feeds = [
      { id: 1, url: 'https://bad.example/rss', webhook: 'https://discord.com/api/webhooks/1', name: 'bad', feed_type: 'alice' },
      { id: 2, url: 'https://good.example/rss', webhook: 'https://discord.com/api/webhooks/2', name: 'good', feed_type: 'alice' }
    ];

    mockParseURL
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        items: [
          {
            pubDate: 'Wed, 02 Oct 2002 13:00:00 GMT',
            title: 'entry',
            content: '<p>desc</p>',
            link: 'https://good.example/entry'
          }
        ]
      });

    await aliceBlogChecker.checkAndUpdateFeeds(feeds);

    expect(mockParseURL).toHaveBeenCalledTimes(2);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('continues when first feed URL is unsafe', async () => {
    const feeds = [
      { id: 1, url: 'http://localhost/internal', webhook: 'https://discord.com/api/webhooks/1', name: 'bad', feed_type: 'alice' },
      { id: 2, url: 'https://good.example/rss', webhook: 'https://discord.com/api/webhooks/2', name: 'good', feed_type: 'alice' }
    ];

    mockParseURL.mockResolvedValue({
      items: [
        {
          pubDate: 'Wed, 02 Oct 2002 13:00:00 GMT',
          title: 'entry',
          content: '<p>desc</p>',
          link: 'https://good.example/entry'
        }
      ]
    });

    await aliceBlogChecker.checkAndUpdateFeeds(feeds);

    expect(mockParseURL).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockPostDiscordOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          content: expect.stringContaining('Unsafe URL for feed url')
        })
      })
    );
  });

  it('includes feed URL in error webhook message', async () => {
    mockParseURL.mockRejectedValue(new Error('feed parse failure'));

    await aliceBlogChecker.checkAndUpdateFeeds([
      { id: 1, url: 'https://broken.example/rss', webhook: 'https://discord.com/api/webhooks/1', name: 'broken', feed_type: 'alice' }
    ]);

    expect(mockPostDiscordOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: process.env.ERROR_WEBHOOK_URL,
        payload: expect.objectContaining({
          content: expect.stringContaining('url=[REDACTED URL:broken.example]')
        })
      })
    );
  });
});
