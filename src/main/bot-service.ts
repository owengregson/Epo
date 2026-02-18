import * as path from 'path';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { InstagramClient } from '../core/instagram-client';
import { FollowerScraper } from '../core/scraper';
import { InstagramActions } from '../core/actions';
import { RateLimiter } from '../core/rate-limiter';
import { createEmptyState, loadState, saveState } from '../state/state';
import { createEmptyCursor, loadCursor, saveCursor } from '../state/scrape-cursor';
import {
  AppState, BotStatus, Settings, DEFAULT_SETTINGS, ScrapeCursor, FollowerEntry,
} from '../types';
import * as logger from '../utils/logger';
import { isSameDay } from '../utils/time';
import { sleep } from '../utils/humanize';
import * as fs from 'fs';

export class BotService extends EventEmitter {
  private settings: Settings;
  private state: AppState;
  private client: InstagramClient | null = null;
  private scraper = new FollowerScraper();
  private actions = new InstagramActions();
  private rateLimiter: RateLimiter;
  private running = false;
  private busy = false;
  private lastAction = 'Idle';
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  private settingsPath: string;
  private statePath: string;
  private cursorPath: string;
  private cookiesPath: string;

  constructor() {
    super();
    const dataDir = app.getPath('userData');
    this.settingsPath = path.join(dataDir, 'peanut-settings.json');
    this.statePath = path.join(dataDir, 'peanut-state.json');
    this.cursorPath = path.join(dataDir, 'peanut-cursor.json');
    this.cookiesPath = path.join(dataDir, 'peanut-cookies.json');

    this.settings = this.loadSettings();
    this.state = loadState(this.statePath, this.settings.target);
    this.rateLimiter = new RateLimiter(this.settings);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  private loadSettings(): Settings {
    if (!fs.existsSync(this.settingsPath)) return { ...DEFAULT_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  }

  private saveSettings(): void {
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  updateSettings(partial: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...partial };
    this.saveSettings();
    this.rateLimiter.updateSettings(this.settings);
    this.state = loadState(this.statePath, this.settings.target);
    return this.settings;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus(): BotStatus {
    const cursor = fs.existsSync(this.cursorPath)
      ? loadCursor(this.cursorPath, this.settings.target)
      : null;

    return {
      running: this.running,
      busy: this.busy,
      lastAction: this.lastAction,
      target: this.settings.target,
      followerCount: this.state.followerList.length,
      nextFollowIndex: this.state.nextFollowIndex,
      queuedFollows: this.state.followQueue.length,
      pendingUnfollows: this.state.pendingUnfollows.length,
      nextFollowAt: this.state.followQueue[0]?.scheduledAt ?? null,
      nextUnfollowAt: this.state.pendingUnfollows[0]?.scheduledAt ?? null,
      scrapeProgress: cursor
        ? {
            totalCollected: cursor.totalCollected,
            isComplete: cursor.isComplete,
            isActive: this.busy && this.lastAction.includes('Scraping'),
          }
        : null,
    };
  }

  getFollowerList(): { followerList: FollowerEntry[]; nextFollowIndex: number } {
    return {
      followerList: this.state.followerList,
      nextFollowIndex: this.state.nextFollowIndex,
    };
  }

  // ── Client Management ─────────────────────────────────────────────────────

  private async initClient(): Promise<void> {
    if (this.client) return;
    this.client = new InstagramClient({
      cookiesPath: this.cookiesPath,
      headless: this.settings.headless,
      slowMo: this.settings.slowMo,
    });
    await this.client.ensureAuthenticated();
  }

  // ── Scraping ──────────────────────────────────────────────────────────────

  async startScraping(): Promise<void> {
    if (!this.settings.target) throw new Error('No target configured.');
    if (this.busy) throw new Error('Bot is busy.');

    this.busy = true;
    this.lastAction = 'Scraping followers...';
    this.emit('status', this.getStatus());

    try {
      await this.initClient();
      const page = this.client!.getPage();
      if (!page) throw new Error('No browser page available.');

      let cursor = loadCursor(this.cursorPath, this.settings.target);
      if (cursor.isComplete) {
        logger.info('Previous scrape was complete. Starting fresh.');
        cursor = createEmptyCursor(this.settings.target);
      }

      // Detect the logged-in user so we can exclude self and already-followed users
      const loggedInUsername = await this.client!.getLoggedInUsername();

      const result = await this.scraper.scrapeChunk(
        page,
        this.settings.target,
        cursor,
        this.settings.scrapeChunkSize,
        this.settings,
        loggedInUsername ?? undefined,
      );

      // Merge new entries into follower list
      const existingUsernames = new Set(this.state.followerList.map((f) => f.username));
      const newEntries = result.entries.filter((e) => !existingUsernames.has(e.username));
      this.state.followerList = [...this.state.followerList, ...newEntries];

      // Save state and cursor
      saveState(this.statePath, this.state);
      saveCursor(this.cursorPath, result.cursor);

      this.lastAction = `Scraped ${newEntries.length} new followers (${this.state.followerList.length} total)`;
      logger.info(this.lastAction);
    } catch (err: any) {
      logger.error('Scraping failed.', { error: err.message });
      this.lastAction = `Scraping failed: ${err.message}`;
    } finally {
      this.busy = false;
      this.emit('status', this.getStatus());
    }
  }

  // ── Follow/Unfollow Loop ──────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.settings.target) throw new Error('No target configured.');
    if (this.running) return;

    this.state = loadState(this.statePath, this.settings.target);
    await this.initClient();

    this.running = true;
    this.lastAction = 'Scheduler started';
    this.emit('status', this.getStatus());

    // Run first tick immediately, then on interval
    this.tick();
    this.tickInterval = setInterval(() => this.tick(), 60000); // Check every minute
  }

  async stop(): Promise<void> {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.running = false;
    this.lastAction = 'Scheduler stopped';
    this.emit('status', this.getStatus());
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.running) return;
    this.busy = true;

    try {
      this.scheduleDailyFollowsIfNeeded();
      saveState(this.statePath, this.state);

      const now = new Date();

      // Process due follows
      const dueFollows = this.state.followQueue.filter(
        (f) => new Date(f.scheduledAt).getTime() <= now.getTime(),
      );
      this.state.followQueue = this.state.followQueue.filter(
        (f) => new Date(f.scheduledAt).getTime() > now.getTime(),
      );

      for (const follow of dueFollows) {
        if (!this.rateLimiter.canAct()) {
          // Re-queue for later
          this.state.followQueue.push({
            username: follow.username,
            scheduledAt: new Date(Date.now() + 3600000).toISOString(),
          });
          break;
        }

        await this.rateLimiter.waitForNextSlot();

        this.lastAction = `Following @${follow.username}`;
        this.emit('status', this.getStatus());

        const page = this.client!.getPage();
        if (!page) break;

        try {
          const success = await this.actions.followUser(page, follow.username, this.settings);
          if (success) {
            this.rateLimiter.recordAction();
            this.state.followHistory.push({
              username: follow.username,
              followedAt: new Date().toISOString(),
            });
            this.state.pendingUnfollows.push({
              username: follow.username,
              scheduledAt: new Date(
                Date.now() + this.settings.unfollowAfterHours * 3600000,
              ).toISOString(),
            });
          }
        } catch (err: any) {
          logger.warn(`Failed to follow @${follow.username}.`, { error: err.message });
          this.state.followQueue.push({
            username: follow.username,
            scheduledAt: new Date(Date.now() + 600000).toISOString(), // Retry in 10 min
          });
        }

        saveState(this.statePath, this.state);
      }

      // Process due unfollows
      const dueUnfollows = this.state.pendingUnfollows.filter(
        (u) => new Date(u.scheduledAt).getTime() <= now.getTime(),
      );
      this.state.pendingUnfollows = this.state.pendingUnfollows.filter(
        (u) => new Date(u.scheduledAt).getTime() > now.getTime(),
      );

      for (const unfollow of dueUnfollows) {
        if (!this.rateLimiter.canAct()) break;

        await this.rateLimiter.waitForNextSlot();

        this.lastAction = `Unfollowing @${unfollow.username}`;
        this.emit('status', this.getStatus());

        const page = this.client!.getPage();
        if (!page) break;

        try {
          const success = await this.actions.unfollowUser(page, unfollow.username, this.settings);
          if (success) {
            this.rateLimiter.recordAction();
          } else {
            this.state.pendingUnfollows.push({
              username: unfollow.username,
              scheduledAt: new Date(Date.now() + 600000).toISOString(),
            });
          }
        } catch (err: any) {
          logger.warn(`Failed to unfollow @${unfollow.username}.`, { error: err.message });
          this.state.pendingUnfollows.push({
            username: unfollow.username,
            scheduledAt: new Date(Date.now() + 600000).toISOString(),
          });
        }

        saveState(this.statePath, this.state);
      }

      this.lastAction = this.running ? 'Waiting for next action...' : 'Idle';
    } finally {
      this.busy = false;
      this.emit('status', this.getStatus());
    }
  }

  private scheduleDailyFollowsIfNeeded(): void {
    const now = new Date();
    if (this.state.lastDailyPlan && isSameDay(new Date(this.state.lastDailyPlan), now)) {
      return; // Already planned today
    }

    this.state.lastDailyPlan = now.toISOString();
    const queue: { username: string; scheduledAt: string }[] = [];
    let index = this.state.nextFollowIndex;

    const baseInterval =
      ((this.settings.minDelayMinutes + this.settings.maxDelayMinutes) / 2) * 60000;

    while (queue.length < this.settings.maxActionsPerDay && index < this.state.followerList.length) {
      const candidate = this.state.followerList[index];
      const scheduledAt = new Date(now.getTime() + queue.length * baseInterval);
      queue.push({ username: candidate.username, scheduledAt: scheduledAt.toISOString() });
      index++;
    }

    this.state.followQueue = queue;
    this.state.nextFollowIndex = index;

    logger.info(`Planned ${queue.length} follows for today.`);
  }

  // ── Session Management ────────────────────────────────────────────────────

  async clearSession(): Promise<void> {
    this.state = createEmptyState(this.settings.target);
    saveState(this.statePath, this.state);
    if (fs.existsSync(this.cursorPath)) fs.unlinkSync(this.cursorPath);
    this.lastAction = 'Session cleared';
    this.emit('status', this.getStatus());
  }
}
