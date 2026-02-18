import { Settings, TIMING_PROFILES } from '../types';
import * as logger from '../utils/logger';
import { sleep, randomBetween } from '../utils/humanize';

type Page = import('puppeteer').Page;

const INSTAGRAM_BASE = 'https://www.instagram.com';

export class InstagramActions {
  async followUser(page: Page, username: string, settings: Settings): Promise<boolean> {
    const timing = TIMING_PROFILES[settings.aggressiveness];
    logger.info(`Attempting to follow @${username}...`);

    if (settings.dryRun) {
      logger.info(`[DRY RUN] Would follow @${username}.`);
      return true;
    }

    await page.goto(`${INSTAGRAM_BASE}/${username}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await sleep(randomBetween(...timing.navigationDelay));

    // Find the follow button in the header
    const button = await this.findProfileActionButton(page);
    if (!button) {
      logger.warn(`Follow button not found for @${username}.`);
      return false;
    }

    const label = await page.evaluate((btn: Element) => btn.textContent?.trim().toLowerCase() || '', button);

    if (label.includes('following') || label.includes('requested')) {
      logger.info(`Already following @${username}.`);
      return false;
    }

    if (!label.includes('follow')) {
      logger.warn(`Unexpected button label "${label}" for @${username}. Skipping.`);
      return false;
    }

    await button.click();
    await sleep(randomBetween(...timing.actionDelay));

    logger.info(`Followed @${username}.`);
    return true;
  }

  async unfollowUser(page: Page, username: string, settings: Settings): Promise<boolean> {
    const timing = TIMING_PROFILES[settings.aggressiveness];
    logger.info(`Attempting to unfollow @${username}...`);

    if (settings.dryRun) {
      logger.info(`[DRY RUN] Would unfollow @${username}.`);
      return true;
    }

    await page.goto(`${INSTAGRAM_BASE}/${username}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await sleep(randomBetween(...timing.navigationDelay));

    const button = await this.findProfileActionButton(page);
    if (!button) {
      logger.warn(`Unfollow button not found for @${username}.`);
      return false;
    }

    const label = await page.evaluate((btn: Element) => btn.textContent?.trim().toLowerCase() || '', button);

    if (!label.includes('following')) {
      logger.info(`Not following @${username}. Nothing to unfollow.`);
      return false;
    }

    // Click "Following" button to open unfollow confirmation
    await button.click();
    await sleep(randomBetween(800, 1500));

    // Click the "Unfollow" confirmation button
    const confirmed = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const unfollowBtn = buttons.find(
        (btn) => btn.textContent?.trim().toLowerCase() === 'unfollow',
      );
      if (unfollowBtn) {
        unfollowBtn.click();
        return true;
      }
      return false;
    });

    if (!confirmed) {
      logger.warn(`Unfollow confirmation dialog not found for @${username}.`);
      return false;
    }

    await sleep(randomBetween(...timing.actionDelay));
    logger.info(`Unfollowed @${username}.`);
    return true;
  }

  private async findProfileActionButton(page: Page): Promise<any> {
    // Instagram profile action buttons are in the header section
    await page.waitForSelector('header', { timeout: 15000 });
    await sleep(500);

    // Strategy 1: Button in header section
    let button = await page.$('header section button');
    if (button) return button;

    // Strategy 2: Any button in header
    button = await page.$('header button');
    if (button) return button;

    // Strategy 3: Look for Follow/Following text in buttons
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await page.evaluate(
        (el: Element) => el.textContent?.trim().toLowerCase() || '',
        btn,
      );
      if (text === 'follow' || text === 'following' || text === 'requested') {
        return btn;
      }
    }

    return null;
  }
}
