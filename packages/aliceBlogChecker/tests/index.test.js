const { fetchFeeds } = require('../src/index');
const { createClient } = require('@supabase/supabase-js');

jest.mock('@supabase/supabase-js', () => {
  return {
    createClient: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      then: jest.fn((callback) => {
        return callback({ data: [{ id: 1, url: 'https://example.com/rss' }], error: null });
      }),
    })),
  };
});

describe('fetchFeeds', () => {
  it('should fetch feeds from supabase', async () => {
    const feeds = await fetchFeeds();
    expect(feeds).toEqual([{ id: 1, url: 'https://example.com/rss' }]);
  });

  it('should handle errors', async () => {
    createClient.mockImplementationOnce(() => ({
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      then: jest.fn((callback, errCallback) => {
        return errCallback(new Error('Supabase error'));
      }),
    }));

    const feeds = await fetchFeeds();
    expect(feeds).toEqual([]);
  });
});
