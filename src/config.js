const path = require('path');

const resolvePath = (fileName) => path.resolve(process.cwd(), fileName);

const buildConfig = (overrides = {}) => {
  const followIntervalMinutes = Number(process.env.PEANUT_FOLLOW_INTERVAL_MINUTES || 60);
  const dailyFollowLimit = Number(process.env.PEANUT_DAILY_FOLLOW_LIMIT || 30);
  const minFollowingCount = Number(process.env.PEANUT_MIN_FOLLOWING_COUNT || 600);

  return {
    username: process.env.INSTAGRAM_USERNAME,
    password: process.env.INSTAGRAM_PASSWORD,
    target: process.env.INSTAGRAM_TARGET,
    cookiesPath: resolvePath(process.env.PEANUT_COOKIES_PATH || 'cookies.json'),
    statePath: resolvePath(process.env.PEANUT_STATE_PATH || 'state.json'),
    headless: process.env.PEANUT_HEADLESS !== 'false',
    slowMo: Number(process.env.PEANUT_SLOW_MO || 0),
    followIntervalMs: Math.max(1, followIntervalMinutes) * 60 * 1000,
    dailyFollowLimit: Math.max(1, dailyFollowLimit),
    minFollowingCount,
    schedulerIntervalMs: Math.max(1, Number(process.env.PEANUT_SCHEDULER_INTERVAL_MINUTES || 10)) * 60 * 1000,
    ...overrides,
  };
};

module.exports = { buildConfig };
