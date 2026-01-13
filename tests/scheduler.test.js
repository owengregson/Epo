const { planDailyFollows, takeDueItems } = require('../src/scheduler');

const buildState = () => ({
  followerList: [
    { username: 'u1', followingCount: 1000 },
    { username: 'u2', followingCount: 900 },
    { username: 'u3', followingCount: 500 },
  ],
  nextFollowIndex: 0,
  followQueue: [],
  followHistory: [],
  pendingUnfollows: [],
  lastDailyPlan: null,
});

describe('planDailyFollows', () => {
  it('plans follow queue up to daily limit and threshold', () => {
    const state = buildState();
    const now = new Date('2024-01-01T08:00:00Z');

    const planned = planDailyFollows({
      state,
      now,
      dailyLimit: 30,
      followIntervalMs: 60 * 60 * 1000,
      minFollowingCount: 600,
    });

    expect(planned.followQueue).toHaveLength(2);
    expect(planned.nextFollowIndex).toBe(2);
    expect(planned.followQueue[0].username).toBe('u1');
    expect(planned.followQueue[1].username).toBe('u2');
  });
});

describe('takeDueItems', () => {
  it('returns due items and remaining queue', () => {
    const now = new Date('2024-01-01T10:00:00Z');
    const queue = [
      { username: 'u1', scheduledAt: '2024-01-01T08:00:00Z' },
      { username: 'u2', scheduledAt: '2024-01-01T12:00:00Z' },
    ];

    const { due, remaining } = takeDueItems(queue, now);

    expect(due).toHaveLength(1);
    expect(remaining).toHaveLength(1);
    expect(due[0].username).toBe('u1');
  });
});
