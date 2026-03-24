import { jest } from '@jest/globals';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.SUPABASE_DAILY_TABLE_NAME = 'daily';
process.env.ERROR_WEBHOOK_URL = 'https://discord.test/error';
process.env.PRODUCTHUNT_FEED_URL = 'https://producthunt.test/feed';
process.env.DISCORD_DAILY_WEBHOOK_URL = 'https://discord.test/daily';
process.env.NODE_ENV = 'test';

const fetchProductJsonMock = jest.fn();
const fetchWithRetryMock = jest.fn();
const postDiscordOrThrowMock = jest.fn();
const selectMock = jest.fn().mockResolvedValue({ data: [{ forum_id: 'thread/123?x=1' }], error: null });
const fromMock = jest.fn(() => ({ select: selectMock }));

jest.unstable_mockModule('../../common/httpClient.js', () => ({
  fetchWithRetry: fetchWithRetryMock,
  postDiscordOrThrow: postDiscordOrThrowMock
}));

jest.unstable_mockModule('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: fromMock
  }))
}));

const {
  fetchProductHuntData,
  sendToDiscord,
  main,
  handleError,
  BusinessValidationError
} = await import('../index.js');

describe('getPopularProducts responsibility split', () => {
  beforeEach(() => {
    fetchProductJsonMock.mockReset();
    fetchWithRetryMock.mockReset();
    postDiscordOrThrowMock.mockReset();
    selectMock.mockClear();
    fromMock.mockClear();

    fetchWithRetryMock.mockResolvedValue({ json: fetchProductJsonMock });
  });

  test('Round1: fetchProductHuntData delegates HTTP to fetchWithRetry and validates business payload', async () => {
    fetchProductJsonMock.mockResolvedValue({
      items: [{ id: 1, title: 'A', url: 'https://example.com/a' }]
    });

    await expect(fetchProductHuntData()).resolves.toEqual([{ id: 1, title: 'A', url: 'https://example.com/a' }]);

    expect(fetchWithRetryMock).toHaveBeenCalledWith(
      'https://producthunt.test/feed',
      {},
      { jobName: 'getPopularProducts:fetchProductHuntData' }
    );
  });

  test('Round1: fetchProductHuntData throws BusinessValidationError on invalid payloads', async () => {
    fetchProductJsonMock.mockResolvedValue(null);
    await expect(fetchProductHuntData()).rejects.toBeInstanceOf(BusinessValidationError);

    fetchProductJsonMock.mockResolvedValue({ items: 'invalid' });
    await expect(fetchProductHuntData()).rejects.toBeInstanceOf(BusinessValidationError);

    fetchProductJsonMock.mockResolvedValue({ items: [] });
    await expect(fetchProductHuntData()).rejects.toBeInstanceOf(BusinessValidationError);

    fetchProductJsonMock.mockResolvedValue({ items: [{ title: '', url: 'https://example.com' }] });
    await expect(fetchProductHuntData()).rejects.toBeInstanceOf(BusinessValidationError);
  });

  test('Round2: sendToDiscord uses postDiscordOrThrow only and URL-encodes thread id', async () => {
    postDiscordOrThrowMock.mockResolvedValue(undefined);

    const embeds = [[{ title: '1. Product A' }], [{ title: '2. Product B' }]];
    await sendToDiscord(embeds);

    expect(postDiscordOrThrowMock).toHaveBeenCalledTimes(2);
    expect(postDiscordOrThrowMock).toHaveBeenNthCalledWith(1, {
      webhookUrl: 'https://discord.test/daily?thread_id=thread%2F123%3Fx%3D1',
      payload: { embeds: embeds[0] },
      jobName: 'getPopularProducts:postDiscordOrThrow'
    });
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  test('Round2: sendToDiscord throws BusinessValidationError when forum_id or embeds is invalid', async () => {
    await expect(sendToDiscord('invalid')).rejects.toBeInstanceOf(BusinessValidationError);

    selectMock.mockResolvedValueOnce({ data: [{ forum_id: '   ' }], error: null });
    await expect(sendToDiscord([[{ title: 'test' }]])).rejects.toBeInstanceOf(BusinessValidationError);

    expect(postDiscordOrThrowMock).not.toHaveBeenCalled();
  });

  test('Round3: handleError sanitizes/redacts and truncates messages', async () => {
    postDiscordOrThrowMock.mockResolvedValue(undefined);

    const longMessage = `token leak https://x.test/webhook?secret=abc ${'x'.repeat(2000)}\nline2`;
    await handleError([new Error(longMessage)]);

    const [{ payload }] = postDiscordOrThrowMock.mock.calls[0];
    expect(payload.content).toContain('[REDACTED_URL]');
    expect(payload.content).not.toContain('https://x.test/webhook?secret=abc');
    expect(payload.content.length).toBeLessThanOrEqual(1800);
  });

  test('Round3: main notifies business errors and rethrows non-business errors after notify', async () => {
    fetchProductJsonMock.mockResolvedValue({ items: [] });
    postDiscordOrThrowMock.mockResolvedValue(undefined);
    await expect(main()).resolves.toBeUndefined();

    const unknownError = new Error('internal\nstack\ttrace');
    fetchWithRetryMock.mockRejectedValue(unknownError);
    await expect(main()).rejects.toThrow('internal\nstack\ttrace');
  });
});
