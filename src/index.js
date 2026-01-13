#!/usr/bin/env node

const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const InstagramClient = require('./instagram');
const { buildConfig } = require('./config');
const { loadState, saveState } = require('./state');
const { sortFollowersByFollowingCount } = require('./utils/sort');
const { planDailyFollows, takeDueItems, scheduleLoop } = require('./scheduler');
const logger = require('./utils/logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = () => yargs(hideBin(process.argv))
  .option('target', {
    type: 'string',
    description: 'Instagram username to target',
  })
  .option('refresh', {
    type: 'boolean',
    default: false,
    description: 'Refresh follower list even if cached',
  })
  .option('headless', {
    type: 'boolean',
    description: 'Run browser in headless mode',
  })
  .option('dry-run', {
    type: 'boolean',
    default: false,
    description: 'Log actions without clicking follow/unfollow',
  })
  .help()
  .argv;

const ensureCredentials = (config) => {
  if (!config.target) {
    throw new Error('Missing target username. Set INSTAGRAM_TARGET or pass --target.');
  }
};

const buildFollowerList = async (client, state, config) => {
  logger.info(`Collecting followers for @${config.target}.`);
  const followers = await client.fetchFollowers(config.target);
  logger.info(`Found ${followers.length} followers. Fetching following counts.`);

  const entries = [];
  for (const username of followers) {
    try {
      const count = await client.fetchFollowingCount(username);
      entries.push({ username, followingCount: count });
      logger.info(`Fetched @${username} (${count} following).`);
      await sleep(2000);
    } catch (error) {
      logger.warn(`Failed to fetch following count for @${username}.`, { error: error.message });
    }
  }

  const sorted = sortFollowersByFollowingCount(entries);
  return {
    ...state,
    followerList: sorted,
    nextFollowIndex: 0,
  };
};

const scheduleFollowsIfNeeded = ({ state, config }) => {
  const updated = planDailyFollows({
    state,
    now: new Date(),
    dailyLimit: config.dailyFollowLimit,
    followIntervalMs: config.followIntervalMs,
    minFollowingCount: config.minFollowingCount,
  });
  return updated;
};

const getNextCandidate = (state) => state.followerList[state.nextFollowIndex];

const shouldContinue = (state, minFollowingCount) => {
  if (state.followQueue.length > 0) {
    return true;
  }
  const next = getNextCandidate(state);
  if (!next) {
    return false;
  }
  return next.followingCount >= minFollowingCount;
};

const applyFollow = (state, username, followedAt) => ({
  ...state,
  followHistory: [...state.followHistory, { username, followedAt }],
  pendingUnfollows: [
    ...state.pendingUnfollows,
    { username, scheduledAt: new Date(followedAt.getTime() + 24 * 60 * 60 * 1000).toISOString() },
  ],
});

const applyUnfollow = (state, username) => ({
  ...state,
  pendingUnfollows: state.pendingUnfollows.filter((item) => item.username !== username),
});

const run = async () => {
  const argv = parseArgs();
  const config = buildConfig({
    target: argv.target || process.env.INSTAGRAM_TARGET,
    headless: argv.headless ?? process.env.PEANUT_HEADLESS !== 'false',
  });

  ensureCredentials(config);

  let state = loadState(config.statePath, config.target);
  const client = new InstagramClient({
    cookiesPath: config.cookiesPath,
    headless: config.headless,
    slowMo: config.slowMo,
  });

  await client.ensureAuthenticated();

  if (argv.refresh || state.followerList.length === 0) {
    state = await buildFollowerList(client, state, config);
    saveState(config.statePath, state);
  }

  let tickInProgress = false;

  const tick = async () => {
    if (tickInProgress) {
      return;
    }
    tickInProgress = true;
    try {
      state = scheduleFollowsIfNeeded({ state, config });
      saveState(config.statePath, state);

      const now = new Date();
      const { due: dueFollows, remaining: remainingQueue } = takeDueItems(state.followQueue, now);
      state.followQueue = remainingQueue;

      for (const follow of dueFollows) {
        logger.info(`Following @${follow.username}.`);
        if (!argv['dry-run']) {
          try {
            const followed = await client.followUser(follow.username);
            if (followed) {
              state = applyFollow(state, follow.username, new Date());
            } else {
              state.followQueue.push({
                username: follow.username,
                scheduledAt: new Date(Date.now() + config.followIntervalMs).toISOString(),
              });
            }
          } catch (error) {
            logger.warn(`Failed to follow @${follow.username}.`, { error: error.message });
            state.followQueue.push({
              username: follow.username,
              scheduledAt: new Date(Date.now() + config.followIntervalMs).toISOString(),
            });
          }
        } else {
          state = applyFollow(state, follow.username, new Date());
        }
        saveState(config.statePath, state);
      }

      const { due: dueUnfollows, remaining: remainingUnfollows } = takeDueItems(state.pendingUnfollows, now);
      state.pendingUnfollows = remainingUnfollows;

      for (const unfollow of dueUnfollows) {
        logger.info(`Unfollowing @${unfollow.username}.`);
        if (!argv['dry-run']) {
          try {
            const unfollowed = await client.unfollowUser(unfollow.username);
            if (unfollowed) {
              state = applyUnfollow(state, unfollow.username);
            } else {
              state.pendingUnfollows.push({
                username: unfollow.username,
                scheduledAt: new Date(Date.now() + config.followIntervalMs).toISOString(),
              });
            }
          } catch (error) {
            logger.warn(`Failed to unfollow @${unfollow.username}.`, { error: error.message });
            state.pendingUnfollows.push({
              username: unfollow.username,
              scheduledAt: new Date(Date.now() + config.followIntervalMs).toISOString(),
            });
          }
        } else {
          state = applyUnfollow(state, unfollow.username);
        }
        saveState(config.statePath, state);
      }

      if (!shouldContinue(state, config.minFollowingCount)) {
        logger.info('Threshold reached or no more followers. Stopping scheduler.');
        stopLoop();
        await client.close();
        process.exit(0);
      }
    } finally {
      tickInProgress = false;
    }
  };

  const stopLoop = scheduleLoop({ intervalMs: config.schedulerIntervalMs, onTick: tick });

  logger.info('Scheduler started.');
  await tick();
};

if (require.main === module) {
  run().catch((error) => {
    logger.error('Fatal error in Peanut bot.', { error: error.message });
    process.exit(1);
  });
}
