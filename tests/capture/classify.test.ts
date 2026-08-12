import { classify, isInterestingJson } from '@/capture/classify';

describe('classify', () => {
  test('friendships/show_many → show-many (checked before followers)', () => {
    expect(
      classify('https://www.instagram.com/api/v1/friendships/show_many/'),
    ).toBe('show-many');
    // show_many URLs also contain "friendships/" but must NOT be misread as followers-list.
    expect(
      classify('https://i.instagram.com/api/v1/friendships/show_many/?query=1'),
    ).toBe('show-many');
  });

  test('friendships/show/<pk>/ → friendship-show (checked before show_many/followers)', () => {
    expect(
      classify('https://www.instagram.com/api/v1/friendships/show/12345/'),
    ).toBe('friendship-show');
    expect(
      classify('https://i.instagram.com/api/v1/friendships/show/17841400000/'),
    ).toBe('friendship-show');
    // show_many must NOT be misread as the single-show endpoint.
    expect(
      classify('https://www.instagram.com/api/v1/friendships/show_many/'),
    ).toBe('show-many');
  });

  test('friendships/<pk>/followers → followers-list', () => {
    expect(
      classify(
        'https://www.instagram.com/api/v1/friendships/17841400000/followers/?count=12',
      ),
    ).toBe('followers-list');
  });

  test('graphql followers query → followers-list', () => {
    expect(
      classify('https://www.instagram.com/graphql/query/?query=followers&id=1'),
    ).toBe('followers-list');
  });

  test('web_profile_info → profile-info', () => {
    expect(
      classify(
        'https://www.instagram.com/api/v1/users/web_profile_info/?username=x',
      ),
    ).toBe('profile-info');
  });

  test('/api/v1/users/ → profile-info', () => {
    expect(
      classify('https://i.instagram.com/api/v1/users/17841400000/info/'),
    ).toBe('profile-info');
  });

  test('news/inbox → activity-feed', () => {
    expect(classify('https://www.instagram.com/api/v1/news/inbox/')).toBe(
      'activity-feed',
    );
  });

  test('other /graphql → graphql-other', () => {
    expect(
      classify('https://www.instagram.com/graphql/query/?query=timeline'),
    ).toBe('graphql-other');
  });

  test('unrelated URL → other', () => {
    expect(classify('https://www.instagram.com/static/bundle.js')).toBe(
      'other',
    );
    expect(classify('https://example.com/')).toBe('other');
  });
});

describe('isInterestingJson', () => {
  test('json mime + IG API path is interesting', () => {
    expect(
      isInterestingJson(
        'https://www.instagram.com/api/v1/users/web_profile_info/?username=x',
        'application/json; charset=utf-8',
      ),
    ).toBe(true);
    expect(
      isInterestingJson(
        'https://www.instagram.com/graphql/query/',
        'application/json',
      ),
    ).toBe(true);
    expect(
      isInterestingJson(
        'https://www.instagram.com/api/v1/friendships/show_many/',
        'application/json',
      ),
    ).toBe(true);
    expect(
      isInterestingJson(
        'https://www.instagram.com/api/v1/news/inbox/',
        'application/json',
      ),
    ).toBe(true);
  });

  test('non-json mime is never interesting', () => {
    expect(
      isInterestingJson(
        'https://www.instagram.com/api/v1/users/web_profile_info/',
        'text/html',
      ),
    ).toBe(false);
  });

  test('json mime but non-API url is not interesting', () => {
    expect(
      isInterestingJson('https://www.instagram.com/manifest.json', 'application/json'),
    ).toBe(false);
  });
});
