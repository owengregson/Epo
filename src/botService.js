const EventEmitter = require('events');
const fs = require('fs');
const InstagramClient = require('./instagram');
const { buildConfig } = require('./config');
const { createEmptyState, loadState, saveState } = require('./state');
const { sortFollowersByFollowingCount } = require('./utils/sort');
const { planDailyFollows, takeDueItems, scheduleLoop } = require('./scheduler');
const logger = require('./utils/logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_SETTINGS = {
  target: '',
  headless: true,
  dryRun: false,
  followIntervalMinutes: 60,
  dailyFollowLimit: 30,
  minFollowingCount: 600,
  schedulerIntervalMinutes: 10,
  slowMo: 0,
};

class BotService extends EventEmitter {
  constructor({ settingsPath }) {
    super();
    this.settingsPath = settingsPath;
    this.settings = this.loadSettings();
    this.config = this.buildConfig();
    this.state = createEmptyState(this.settings.target);
    this.client = null;
    this.stopLoop = null;
    this.running = false;
    this.busy = false;
    this.lastAction = 'Idle';
  }

  loadSettings() {
    if (!this.settingsPath || !fs.existsSync(this.settingsPath)) {
      return { ...DEFAULT_SETTINGS };
    }
    const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  }

  saveSettings() {
    if (!this.settingsPath) {
      return;
    }
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
  }

  buildConfig() {
    return buildConfig({
      target: this.settings.target,
      headless: this.settings.headless,
      slowMo: this.settings.slowMo,
      followIntervalMs: Math.max(1, Number(this.settings.followIntervalMinutes)) * 60 * 1000,
      dailyFollowLimit: Math.max(1, Number(this.settings.dailyFollowLimit)),
      minFollowingCount: Number(this.settings.minFollowingCount),
      schedulerIntervalMs: Math.max(1, Number(this.settings.schedulerIntervalMinutes)) * 60 * 1000,
    });
  }

  updateSettings(partial) {
    this.settings = { ...this.settings, ...partial };
    this.saveSettings();
    this.config = this.buildConfig();
    this.state = loadState(this.config.statePath, this.config.target);
    return this.settings;
  }

  getSettings() {
    return { ...this.settings };
  }

  getStatus() {
    const nextFollow = this.state.followQueue[0];
    const nextUnfollow = this.state.pendingUnfollows[0];
    return {
      running: this.running,
      busy: this.busy,
      lastAction: this.lastAction,
      target: this.config.target,
      headless: this.config.headless,
      followerCount: this.state.followerList.length,
      nextFollowIndex: this.state.nextFollowIndex,
      queuedFollows: this.state.followQueue.length,
      pendingUnfollows: this.state.pendingUnfollows.length,
      nextFollowAt: nextFollow ? nextFollow.scheduledAt : null,
      nextUnfollowAt: nextUnfollow ? nextUnfollow.scheduledAt : null,
    };
  }

  getTargets() {
    return {
      followerList: this.state.followerList,
      nextFollowIndex: this.state.nextFollowIndex,
    };
  }

  ensureTarget() {
    if (!this.config.target) {
      throw new Error('Missing target username. Configure a target before starting.');
    }
  }

  async initClient() {
    if (this.client) {
      return;
    }
    this.client = new InstagramClient({
      cookiesPath: this.config.cookiesPath,
      headless: this.config.headless,
      slowMo: this.config.slowMo,
    });
    await this.client.ensureAuthenticated();
  }

  async refreshFollowers() {
    this.ensureTarget();
    await this.initClient();
    this.busy = true;
    this.lastAction = 'Refreshing followers list';
    this.emit('status', this.getStatus());
    logger.info(`Collecting followers for @${this.config.target}.`);
    const followers = await this.client.fetchFollowers(this.config.target);
    logger.info(`Found ${followers.length} followers. Fetching following counts.`);

    const entries = [];
    for (const username of followers) {
      try {
        const count = await this.client.fetchFollowingCount(username);
        entries.push({ username, followingCount: count });
        logger.info(`Fetched @${username} (${count} following).`);
        await sleep(2000);
      } catch (error) {
        logger.warn(`Failed to fetch following count for @${username}.`, { error: error.message });
      }
    }

    const sorted = sortFollowersByFollowingCount(entries);
    this.state = {
      ...this.state,
      followerList: sorted,
      nextFollowIndex: 0,
    };
    saveState(this.config.statePath, this.state);
    this.busy = false;
    this.lastAction = 'Follower list updated';
    this.emit('status', this.getStatus());
    return this.state.followerList;
  }

  scheduleFollowsIfNeeded() {
    this.state = planDailyFollows({
      state: this.state,
      now: new Date(),
      dailyLimit: this.config.dailyFollowLimit,
      followIntervalMs: this.config.followIntervalMs,
      minFollowingCount: this.config.minFollowingCount,
    });
  }

  getNextCandidate() {
    return this.state.followerList[this.state.nextFollowIndex];
  }

  shouldContinue() {
    if (this.state.followQueue.length > 0) {
      return true;
    }
    const next = this.getNextCandidate();
    if (!next) {
      return false;
    }
    return next.followingCount >= this.config.minFollowingCount;
  }

  applyFollow(username, followedAt) {
    this.state = {
      ...this.state,
      followHistory: [...this.state.followHistory, { username, followedAt }],
      pendingUnfollows: [
        ...this.state.pendingUnfollows,
        { username, scheduledAt: new Date(followedAt.getTime() + 24 * 60 * 60 * 1000).toISOString() },
      ],
    };
  }

  applyUnfollow(username) {
    this.state = {
      ...this.state,
      pendingUnfollows: this.state.pendingUnfollows.filter((item) => item.username !== username),
    };
  }

  async tick() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      this.scheduleFollowsIfNeeded();
      saveState(this.config.statePath, this.state);

      const now = new Date();
      const { due: dueFollows, remaining: remainingQueue } = takeDueItems(this.state.followQueue, now);
      this.state.followQueue = remainingQueue;

      for (const follow of dueFollows) {
        this.lastAction = `Following @${follow.username}`;
        this.emit('status', this.getStatus());
        if (!this.settings.dryRun) {
          try {
            const followed = await this.client.followUser(follow.username);
            if (followed) {
              this.applyFollow(follow.username, new Date());
            } else {
              this.state.followQueue.push({
                username: follow.username,
                scheduledAt: new Date(Date.now() + this.config.followIntervalMs).toISOString(),
              });
            }
          } catch (error) {
            logger.warn(`Failed to follow @${follow.username}.`, { error: error.message });
            this.state.followQueue.push({
              username: follow.username,
              scheduledAt: new Date(Date.now() + this.config.followIntervalMs).toISOString(),
            });
          }
        } else {
          this.applyFollow(follow.username, new Date());
        }
        saveState(this.config.statePath, this.state);
      }

      const { due: dueUnfollows, remaining: remainingUnfollows } = takeDueItems(this.state.pendingUnfollows, now);
      this.state.pendingUnfollows = remainingUnfollows;

      for (const unfollow of dueUnfollows) {
        this.lastAction = `Unfollowing @${unfollow.username}`;
        this.emit('status', this.getStatus());
        if (!this.settings.dryRun) {
          try {
            const unfollowed = await this.client.unfollowUser(unfollow.username);
            if (unfollowed) {
              this.applyUnfollow(unfollow.username);
            } else {
              this.state.pendingUnfollows.push({
                username: unfollow.username,
                scheduledAt: new Date(Date.now() + this.config.followIntervalMs).toISOString(),
              });
            }
          } catch (error) {
            logger.warn(`Failed to unfollow @${unfollow.username}.`, { error: error.message });
            this.state.pendingUnfollows.push({
              username: unfollow.username,
              scheduledAt: new Date(Date.now() + this.config.followIntervalMs).toISOString(),
            });
          }
        } else {
          this.applyUnfollow(unfollow.username);
        }
        saveState(this.config.statePath, this.state);
      }

      if (!this.shouldContinue()) {
        logger.info('Threshold reached or no more followers. Stopping scheduler.');
        await this.stop();
      }
    } finally {
      this.busy = false;
      this.emit('status', this.getStatus());
    }
  }

  async start() {
    this.ensureTarget();
    if (this.running) {
      return;
    }
    this.state = loadState(this.config.statePath, this.config.target);
    await this.initClient();
    this.running = true;
    this.lastAction = 'Scheduler started';
    this.stopLoop = scheduleLoop({
      intervalMs: this.config.schedulerIntervalMs,
      onTick: () => this.tick(),
    });
    await this.tick();
  }

  async stop() {
    if (this.stopLoop) {
      this.stopLoop();
      this.stopLoop = null;
    }
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.running = false;
    this.lastAction = 'Scheduler stopped';
    this.emit('status', this.getStatus());
  }

  async clearSession() {
    this.state = createEmptyState(this.config.target);
    saveState(this.config.statePath, this.state);
    this.lastAction = 'Session cleared';
    this.emit('status', this.getStatus());
  }

  async toggleHeadless(headless) {
    this.settings = { ...this.settings, headless: Boolean(headless) };
    this.saveSettings();
    this.config = this.buildConfig();
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.running) {
      await this.initClient();
    }
    this.lastAction = this.config.headless ? 'Instagram running headless' : 'Instagram running visible';
    this.emit('status', this.getStatus());
    return this.config.headless;
  }
}

module.exports = BotService;
