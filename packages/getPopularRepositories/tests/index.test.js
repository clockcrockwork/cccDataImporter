import { jest, beforeEach, afterEach, describe, test, expect } from '@jest/globals';

const REQUIRED_ENV = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_KEY: 'supabase-key',
  SUPABASE_DAILY_TABLE_NAME: 'daily_table',
  ERROR_WEBHOOK_URL: 'https://discord.test/error',
  GIT_REPOSITORY_FEED_URL: 'https://feed.test',
  DISCORD_DAILY_WEBHOOK_URL: 'https://discord.test/daily',
  GITHUB_ACTIONS: 'true',
  NODE_ENV: 'test'
};

function createJsonResponse(items = []) {
  return {
    async json() {
      return { items };
    }
  };
}

describe('getPopularRepositories', () => {
  beforeEach(() => {
    jest.resetModules();
    Object.entries(REQUIRED_ENV).forEach(([key, value]) => {
      process.env[key] = value;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('throws business error when success categories are below threshold', async () => {
    const { fetchGitHubTrends } = await import('../index.js');

    const fetchWithRetryMock = jest.fn()
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-1' }]))
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-2' }]))
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-3' }]))
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-4' }]))
      .mockRejectedValue(new Error('category failed'));

    const logMock = jest.fn();

    await expect(fetchGitHubTrends({ fetchWithRetryImpl: fetchWithRetryMock, logImpl: logMock }))
      .rejects
      .toThrow('BusinessError: insufficient successful categories');

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(22);
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('successCount=4, failureCount=18'));
  });

  test('main does not send daily post and reports business error when posts are empty', async () => {
    const { main } = await import('../index.js');

    const sendToDiscordMock = jest.fn();
    const handleErrorMock = jest.fn();

    await main({
      fetchGitHubTrendsImpl: jest.fn().mockResolvedValue([]),
      sendToDiscordImpl: sendToDiscordMock,
      handleErrorImpl: handleErrorMock
    });

    expect(sendToDiscordMock).not.toHaveBeenCalled();
    expect(handleErrorMock).toHaveBeenCalledTimes(1);
    expect(handleErrorMock.mock.calls[0][0][0].message).toContain('BusinessError: no valid posts after category aggregation');
  });

  test('logs success and failure category counts', async () => {
    const { fetchGitHubTrends } = await import('../index.js');

    const fetchWithRetryMock = jest.fn()
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-1' }]))
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-2' }]))
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-3' }]))
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-4' }]))
      .mockResolvedValueOnce(createJsonResponse([{ title: 'ok-5' }]))
      .mockRejectedValue(new Error('category failed'));

    const logMock = jest.fn();

    const posts = await fetchGitHubTrends({ fetchWithRetryImpl: fetchWithRetryMock, logImpl: logMock });

    expect(posts).toHaveLength(5);
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('successCount=5, failureCount=17'));
  });

  test('treats invalid payload items as failed category', async () => {
    const { fetchGitHubTrends } = await import('../index.js');

    const fetchWithRetryMock = jest.fn()
      .mockResolvedValueOnce({ json: async () => ({ items: 'invalid' }) })
      .mockResolvedValue(createJsonResponse([{ title: 'ok' }]));

    const logMock = jest.fn();

    const posts = await fetchGitHubTrends({ fetchWithRetryImpl: fetchWithRetryMock, logImpl: logMock });

    expect(posts.length).toBe(21);
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('successCount=21, failureCount=1'));
  });



  test('main ignores invalid post records and blocks posting when all are invalid', async () => {
    const { main } = await import('../index.js');

    const sendToDiscordMock = jest.fn();
    const handleErrorMock = jest.fn();

    await main({
      fetchGitHubTrendsImpl: jest.fn().mockResolvedValue([{ title: '', url: 'https://x', content_html: '' }]),
      sendToDiscordImpl: sendToDiscordMock,
      handleErrorImpl: handleErrorMock
    });

    expect(sendToDiscordMock).not.toHaveBeenCalled();
    expect(handleErrorMock.mock.calls[0][0][0].message).toContain('BusinessError: no valid posts after category aggregation');
  });
  test('sendToDiscord rejects non-numeric thread id', async () => {
    const { sendToDiscord } = await import('../index.js');

    await expect(sendToDiscord([[{ title: 'x' }]], {
      getDiscordThreadIdImpl: jest.fn().mockResolvedValue('abc'),
      postDiscordOrThrowImpl: jest.fn()
    })).rejects.toThrow('BusinessError: invalid Discord thread id');
  });
});
