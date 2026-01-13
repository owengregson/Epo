const { sortFollowersByFollowingCount } = require('../src/utils/sort');

describe('sortFollowersByFollowingCount', () => {
  it('sorts followers by followingCount descending', () => {
    const input = [
      { username: 'alpha', followingCount: 10 },
      { username: 'beta', followingCount: 200 },
      { username: 'gamma', followingCount: 150 },
    ];

    const result = sortFollowersByFollowingCount(input);

    expect(result.map((item) => item.username)).toEqual(['beta', 'gamma', 'alpha']);
  });
});
