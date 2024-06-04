const { fetchFeeds } = require('../src/index');
const { createClient } = require('@supabase/supabase-js');
const { authenticateUser } = require('../src/index');
const supabase = require('@supabase/supabase-js');
const { handleError } = require('../src/index');

const TEST_FEED_URL = process.env.TEST_FEED;

jest.mock('@supabase/supabase-js', () => {
  return {
    createClient: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      then: jest.fn((callback) => {
        return callback({ data: [{ id: 1, url: TEST_FEED_URL }], error: null });
      }),
    })),
  };
});

jest.mock('../src/index', () => ({
  ...jest.requireActual('../src/index'),
  handleError: jest.fn(),
}));

describe('fetchFeeds', () => {
  it('should fetch feeds from supabase', async () => {
    const feeds = await fetchFeeds();
    expect(feeds).toEqual([{ id: 1, url: TEST_FEED_URL }]);
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

  it('should call handleError when there is an error', async () => {
    createClient.mockImplementationOnce(() => ({
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      then: jest.fn((callback, errCallback) => {
        return errCallback(new Error('Supabase error'));
      }),
    }));

    await fetchFeeds();
    expect(handleError).toHaveBeenCalledWith(new Error('Supabase error'));
  });
});
describe('authenticateUser', () => {
  it('should authenticate the user and return the access token', async () => {
    const signInWithPasswordMock = jest.spyOn(supabase.auth, 'signInWithPassword').mockResolvedValue({
      data: {
        session: {
          access_token: 'ACCESS_TOKEN'
        }
      },
      error: null
    });

    const accessToken = await authenticateUser();

    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: SUPABASE_EMAIL,
      password: SUPABASE_PASSWORD
    });
    expect(accessToken).toBe('ACCESS_TOKEN');
  });

  it('should handle authentication error and throw an error', async () => {
    const signInWithPasswordMock = jest.spyOn(supabase.auth, 'signInWithPassword').mockRejectedValue(new Error('Authentication error'));

    await expect(authenticateUser()).rejects.toThrowError('Authentication error');

    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      email: SUPABASE_EMAIL,
      password: SUPABASE_PASSWORD
    });
  });
});