import { Settings } from '../types';
import { humanDelay, isWithinActiveHours, msUntilActiveHours, sleep } from '../utils/humanize';
import * as logger from '../utils/logger';

export class RateLimiter {
  private actionsToday = 0;
  private lastActionDate: string | null = null;
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  private resetDailyCountIfNeeded(): void {
    const today = new Date().toDateString();
    if (this.lastActionDate !== today) {
      this.actionsToday = 0;
      this.lastActionDate = today;
    }
  }

  canAct(): boolean {
    this.resetDailyCountIfNeeded();
    return this.actionsToday < this.settings.maxActionsPerDay;
  }

  async waitForNextSlot(): Promise<void> {
    this.resetDailyCountIfNeeded();

    if (this.actionsToday >= this.settings.maxActionsPerDay) {
      logger.info('Daily action limit reached. Waiting until tomorrow.');
      const msToMidnight = new Date().setHours(24, 0, 0, 0) - Date.now();
      await sleep(msToMidnight + 60000); // +1 min buffer
      this.actionsToday = 0;
      this.lastActionDate = new Date().toDateString();
    }

    if (!isWithinActiveHours(this.settings.activeHoursStart, this.settings.activeHoursEnd)) {
      const waitMs = msUntilActiveHours(this.settings.activeHoursStart);
      logger.info(`Outside active hours. Sleeping ${Math.round(waitMs / 60000)} minutes.`);
      await sleep(waitMs);
    }

    const delayMs = humanDelay(
      this.settings.minDelayMinutes * 60000,
      this.settings.maxDelayMinutes * 60000,
      this.settings.jitterPercent,
    );

    logger.debug(`Rate limiter: waiting ${Math.round(delayMs / 1000)}s before next action.`);
    await sleep(delayMs);
  }

  recordAction(): void {
    this.resetDailyCountIfNeeded();
    this.actionsToday++;
    logger.debug(`Actions today: ${this.actionsToday}/${this.settings.maxActionsPerDay}`);
  }

  getActionsToday(): number {
    this.resetDailyCountIfNeeded();
    return this.actionsToday;
  }
}
