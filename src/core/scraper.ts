import {
  FollowerEntry, ScrapeCursor, Settings,
  TIMING_PROFILES, TimingProfile,
} from '../types';
import * as logger from '../utils/logger';
import { sleep, randomBetween } from '../utils/humanize';

type Page = import('puppeteer').Page;
type HTTPResponse = import('puppeteer').HTTPResponse;

interface GraphQLFollowerNode {
  id: string;
  username: string;
  full_name: string;
  is_verified: boolean;
  profile_pic_url: string;
  followed_by_viewer?: boolean;
  following?: boolean;
}

interface GraphQLFollowerEdge {
  node: GraphQLFollowerNode;
}

interface GraphQLPageInfo {
  has_next_page: boolean;
  end_cursor: string;
}

interface ProfileStats {
  followingCount: number;
  followerCount: number;
}

export class FollowerScraper {
  private collectedUsers: Map<string, FollowerEntry> = new Map();
  private excludedUsernames: Set<string> = new Set();
  private pageInfo: GraphQLPageInfo = { has_next_page: true, end_cursor: '' };
  private timing!: TimingProfile;

  async scrapeChunk(
    page: Page,
    targetUsername: string,
    cursor: ScrapeCursor,
    chunkSize: number,
    settings: Settings,
    loggedInUsername?: string,
  ): Promise<{ entries: FollowerEntry[]; cursor: ScrapeCursor }> {
    // Set timing profile
    this.timing = TIMING_PROFILES[settings.aggressiveness];

    // Reset state for this chunk
    this.collectedUsers = new Map();
    this.excludedUsernames = new Set();
    this.pageInfo = { has_next_page: true, end_cursor: '' };

    // Exclude the logged-in user (self) from results
    if (loggedInUsername) {
      this.excludedUsernames.add(loggedInUsername);
      logger.info(`Will exclude logged-in user @${loggedInUsername} from scrape results.`);
    }

    // Restore previously collected users into our map
    const previouslyCollected = new Set(cursor.collectedUsernames);
    for (const uname of cursor.collectedUsernames) {
      this.collectedUsers.set(uname, {
        username: uname,
        scrapedAt: cursor.lastScrapedAt,
      });
    }

    // Helper: count new usable entries (not previously collected AND not excluded)
    const getNewUsableCount = (): number => {
      let count = 0;
      for (const uname of this.collectedUsers.keys()) {
        if (!previouslyCollected.has(uname) && !this.excludedUsernames.has(uname)) {
          count++;
        }
      }
      return count;
    };

    // Set up API response interceptor
    const responseHandler = this.createResponseInterceptor(page);

    // Navigate to target profile if not already there
    const currentUrl = page.url();
    if (!currentUrl.includes(`/${targetUsername}/`)) {
      await page.goto(`https://www.instagram.com/${targetUsername}/`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await sleep(randomBetween(...this.timing.navigationDelay));
    }

    // Open followers dialog
    await this.openFollowersDialog(page, targetUsername);

    if (cursor.totalCollected > 0) {
      logger.info(`Resuming scrape from position ${cursor.totalCollected}. Scrolling to catch up...`);
    }

    // ── Phase 1: Scroll and collect raw usernames from the dialog ─────────
    // Collect more than chunkSize because many will be filtered in Phase 2.
    const rawTarget = chunkSize * 2;
    let unchangedCount = 0;
    let lastUsableCount = getNewUsableCount();
    const maxUnchanged = this.timing.maxUnchangedRounds;

    // Do an initial DOM scrape before scrolling (captures the first batch)
    await this.scrapeVisibleFollowStatuses(page);

    while (getNewUsableCount() < rawTarget && unchangedCount < maxUnchanged) {
      // Scroll the dialog to trigger loading more followers
      await this.scrollFollowersDialog(page);
      await sleep(randomBetween(...this.timing.scrollDelay));

      // Scrape visible DOM for usernames and follow statuses
      await this.scrapeVisibleFollowStatuses(page);

      const currentUsable = getNewUsableCount();
      if (currentUsable === lastUsableCount) {
        unchangedCount++;
        // If stuck for a while, try aggressive scrolling with longer waits
        if (unchangedCount > 5) {
          logger.debug(`Stuck at ${currentUsable} users. Trying aggressive scroll...`);
          await this.scrollToBottom(page);
          await sleep(randomBetween(...this.timing.scrollStuckDelay));
          await this.scrapeVisibleFollowStatuses(page);
        }
        if (unchangedCount > 8) {
          // Try clicking into the scrollable area then scroll via keyboard
          await this.scrollViaKeyboard(page);
          await sleep(randomBetween(...this.timing.scrollDelay));
          await this.scrapeVisibleFollowStatuses(page);
        }
      } else {
        unchangedCount = 0;
        lastUsableCount = currentUsable;
      }

      logger.debug(
        `Collected ${this.collectedUsers.size} total, ${getNewUsableCount()} new usable ` +
        `(raw target: ${rawTarget}, excluded: ${this.excludedUsernames.size}, ` +
        `${unchangedCount} unchanged rounds).`,
      );
    }

    // Final DOM scrape
    await this.scrapeVisibleFollowStatuses(page);

    // Close the dialog before visiting profiles
    await this.closeDialog(page);
    await sleep(randomBetween(...this.timing.navigationDelay));

    // Remove the interceptor
    responseHandler.remove();

    // Build candidate list - only non-excluded, non-previously-collected
    const allCollectedUsernames = Array.from(this.collectedUsers.keys());
    const candidateUsernames = allCollectedUsernames
      .filter((u) => !previouslyCollected.has(u) && !this.excludedUsernames.has(u));

    logger.info(
      `Phase 1 complete: ${candidateUsernames.length} candidates after filtering ` +
      `(${allCollectedUsernames.length - previouslyCollected.size} scraped, ` +
      `${this.excludedUsernames.size} excluded as already-followed/self).`,
    );

    // ── Phase 2: Visit each candidate's profile and validate ─────────────
    const validatedEntries: FollowerEntry[] = [];
    let visitedCount = 0;

    for (const username of candidateUsernames) {
      if (validatedEntries.length >= chunkSize) break;
      visitedCount++;

      logger.info(
        `Validating profile ${visitedCount}/${candidateUsernames.length}: @${username} ` +
        `(${validatedEntries.length}/${chunkSize} passed so far)`,
      );

      try {
        const stats = await this.getProfileStats(page, username);

        if (!stats) {
          logger.debug(`Could not read stats for @${username}. Skipping.`);
          this.excludedUsernames.add(username);
          continue;
        }

        // Check minimum following threshold
        if (stats.followingCount < settings.minFollowing) {
          logger.debug(
            `@${username} following ${stats.followingCount} < min ${settings.minFollowing}. Skipping.`,
          );
          this.excludedUsernames.add(username);
          continue;
        }

        // Check following/followers ratio tolerance
        if (stats.followerCount > 0) {
          const ratio = stats.followingCount / stats.followerCount;
          const lowerBound = 1 - (settings.followRatioTolerance / 100);
          const upperBound = 1 + (settings.followRatioTolerance / 100);

          if (ratio < lowerBound || ratio > upperBound) {
            logger.debug(
              `@${username} ratio ${ratio.toFixed(2)} (${stats.followingCount}/${stats.followerCount}) ` +
              `outside ${lowerBound.toFixed(2)}-${upperBound.toFixed(2)}. Skipping.`,
            );
            this.excludedUsernames.add(username);
            continue;
          }
        }

        // User passes validation
        const entry = this.collectedUsers.get(username)!;
        entry.followingCount = stats.followingCount;
        entry.followerCount = stats.followerCount;
        validatedEntries.push(entry);

        logger.info(
          `@${username} passed: ${stats.followingCount} following, ` +
          `${stats.followerCount} followers.`,
        );
      } catch (err: any) {
        logger.warn(`Failed to validate @${username}: ${err.message}. Skipping.`);
        this.excludedUsernames.add(username);
      }

      await sleep(randomBetween(...this.timing.profileVisitDelay));
    }

    const isComplete = unchangedCount >= maxUnchanged || !this.pageInfo.has_next_page;

    // Cursor stores ALL collected usernames (including excluded) to avoid re-scraping
    const updatedCursor: ScrapeCursor = {
      targetUsername,
      totalCollected: allCollectedUsernames.length,
      lastUserId: this.pageInfo.end_cursor,
      collectedUsernames: allCollectedUsernames,
      isComplete,
      lastScrapedAt: new Date().toISOString(),
      endCursor: this.pageInfo.end_cursor,
      hasNextPage: this.pageInfo.has_next_page,
    };

    logger.info(
      `Scrape chunk complete: ${validatedEntries.length} validated followers ` +
      `(${visitedCount} profiles visited, ${candidateUsernames.length} candidates). ` +
      `${isComplete ? 'No more available.' : 'More available.'}`,
    );

    return { entries: validatedEntries, cursor: updatedCursor };
  }

  // ── API Response Interceptor ───────────────────────────────────────────────

  private createResponseInterceptor(page: Page): { remove: () => void } {
    const handler = async (response: HTTPResponse) => {
      try {
        const url = response.url();
        if (
          url.includes('/graphql/query') ||
          url.includes('/api/v1/friendships/') ||
          url.includes('followers')
        ) {
          const contentType = response.headers()['content-type'] || '';
          if (!contentType.includes('json')) return;

          const body = await response.json().catch(() => null);
          if (!body) return;

          this.extractFollowersFromResponse(body);
        }
      } catch {
        // Silently ignore parse errors on irrelevant responses
      }
    };

    page.on('response', handler);
    return {
      remove: () => page.off('response', handler),
    };
  }

  private extractFollowersFromResponse(body: any): void {
    const now = new Date().toISOString();

    // Handle GraphQL edge format: data.user.edge_followed_by.edges
    try {
      const edges: GraphQLFollowerEdge[] =
        body?.data?.user?.edge_followed_by?.edges ||
        body?.data?.xdt_api__v1__friendships__followers?.edges ||
        [];

      if (edges.length > 0) {
        for (const edge of edges) {
          const node = edge.node;
          if (node?.username) {
            this.collectedUsers.set(node.username, {
              username: node.username,
              userId: node.id,
              fullName: node.full_name,
              isVerified: node.is_verified,
              scrapedAt: now,
            });

            if (node.followed_by_viewer === true || node.following === true) {
              this.excludedUsernames.add(node.username);
            }
          }
        }

        const pageInfo =
          body?.data?.user?.edge_followed_by?.page_info ||
          body?.data?.xdt_api__v1__friendships__followers?.page_info;

        if (pageInfo) {
          this.pageInfo = {
            has_next_page: pageInfo.has_next_page ?? true,
            end_cursor: pageInfo.end_cursor ?? '',
          };
        }
      }
    } catch {
      // Not the response format we expected
    }

    // Handle REST API format: { users: [...] }
    try {
      const users = body?.users || [];
      if (Array.isArray(users) && users.length > 0) {
        for (const user of users) {
          if (user?.username) {
            this.collectedUsers.set(user.username, {
              username: user.username,
              userId: String(user.pk || user.id || ''),
              fullName: user.full_name || '',
              isVerified: user.is_verified || false,
              scrapedAt: now,
            });

            if (user.following === true || user.friendship_status?.following === true) {
              this.excludedUsernames.add(user.username);
            }
          }
        }

        // REST API pagination
        if (body.next_max_id !== undefined) {
          this.pageInfo = {
            has_next_page: !!body.next_max_id,
            end_cursor: String(body.next_max_id || ''),
          };
        }
      }
    } catch {
      // Not the format we expected
    }

    // Handle nested sections format
    try {
      const sections = body?.sections || [];
      if (Array.isArray(sections)) {
        for (const section of sections) {
          const layoutContent = section?.layout_content?.medias ||
            section?.layout_content?.users || [];
          for (const item of layoutContent) {
            const user = item?.user || item;
            if (user?.username) {
              this.collectedUsers.set(user.username, {
                username: user.username,
                userId: String(user.pk || user.id || ''),
                fullName: user.full_name || '',
                isVerified: user.is_verified || false,
                scrapedAt: now,
              });

              if (user.following === true || user.friendship_status?.following === true) {
                this.excludedUsernames.add(user.username);
              }
            }
          }
        }
      }
    } catch {
      // Not the format we expected
    }
  }

  // ── Dialog Management ──────────────────────────────────────────────────────

  private async openFollowersDialog(page: Page, targetUsername: string): Promise<void> {
    const followersLink = await page.$(`a[href='/${targetUsername}/followers/']`);
    if (followersLink) {
      await followersLink.click();
    } else {
      const links = await page.$$('a[href*="followers"]');
      if (links.length > 0) {
        await links[0].click();
      } else {
        // Fallback: find by text/link matching
        const clicked = await page.evaluate((target: string) => {
          const allLinks = Array.from(document.querySelectorAll('a'));
          for (const link of allLinks) {
            if (link.href.includes(`/${target}/followers`)) {
              link.click();
              return true;
            }
          }
          const spans = Array.from(document.querySelectorAll('span, a'));
          for (const el of spans) {
            if (el.textContent?.toLowerCase().includes('follower') &&
                !el.textContent?.toLowerCase().includes('following')) {
              (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, targetUsername);

        if (!clicked) {
          throw new Error('Could not find followers link on profile page.');
        }
      }
    }

    await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
    await sleep(randomBetween(...this.timing.dialogOpenDelay));
    logger.info('Followers dialog opened.');
  }

  private async closeDialog(page: Page): Promise<void> {
    try {
      await page.keyboard.press('Escape');
      await sleep(500);

      const dialogStillOpen = await page.$('[role="dialog"]');
      if (dialogStillOpen) {
        const closed = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return true;
          const closeBtn = dialog.querySelector('button[aria-label="Close"]') ||
            dialog.querySelector('svg[aria-label="Close"]')?.closest('button');
          if (closeBtn) {
            (closeBtn as HTMLElement).click();
            return true;
          }
          return false;
        });
        if (!closed) {
          await page.keyboard.press('Escape');
        }
        await sleep(500);
      }
    } catch {
      // Dialog may already be closed
    }
  }

  // ── Scrolling ──────────────────────────────────────────────────────────────

  private async scrollFollowersDialog(page: Page): Promise<void> {
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return;

      const allDivs = Array.from(dialog.querySelectorAll('div'));
      let scrollable: HTMLElement | undefined;

      // Strategy 1: Find element with overflow scroll/auto that has scrollable content
      const scrollCandidates = allDivs
        .filter((el) => {
          const s = window.getComputedStyle(el);
          return (
            el.scrollHeight > el.clientHeight + 10 &&
            ['auto', 'scroll'].includes(s.overflowY)
          );
        })
        .sort((a, b) => b.scrollHeight - a.scrollHeight);

      scrollable = scrollCandidates[0];

      // Strategy 2: flex column with many children
      if (!scrollable) {
        scrollable = allDivs.find((el) => {
          const style = window.getComputedStyle(el);
          return (
            style.display === 'flex' &&
            style.flexDirection === 'column' &&
            el.children.length > 4
          );
        });
      }

      // Strategy 3: Any div with many children and tall content
      if (!scrollable) {
        scrollable = allDivs
          .filter((el) => el.children.length > 5)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      }

      if (scrollable) {
        const remaining = scrollable.scrollHeight - scrollable.scrollTop - scrollable.clientHeight;
        if (remaining < 300) {
          scrollable.scrollTop = scrollable.scrollHeight + 1000;
        } else {
          const scrollAmount = Math.floor(Math.random() * 600) + 500;
          scrollable.scrollBy({ top: scrollAmount, behavior: 'auto' });
        }
      }
    });
  }

  private async scrollToBottom(page: Page): Promise<void> {
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return;

      const allDivs = Array.from(dialog.querySelectorAll('div'));
      const scrollable = allDivs
        .filter((el) => {
          const s = window.getComputedStyle(el);
          return (
            el.scrollHeight > el.clientHeight + 10 &&
            ['auto', 'scroll'].includes(s.overflowY)
          );
        })
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight + 1000;
      } else {
        const fallback = allDivs
          .filter((el) => el.children.length > 5)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        if (fallback) {
          fallback.scrollTop = fallback.scrollHeight + 1000;
        }
      }
    });
  }

  private async scrollViaKeyboard(page: Page): Promise<void> {
    try {
      const dialog = await page.$('[role="dialog"]');
      if (dialog) {
        await dialog.click();
        await sleep(100);
      }
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('PageDown');
        await sleep(100);
      }
    } catch {
      // Ignore errors
    }
  }

  // ── DOM Scraping ───────────────────────────────────────────────────────────

  /**
   * Scrapes visible usernames from the followers dialog DOM
   * and detects follow status from button text next to each user.
   */
  private async scrapeVisibleFollowStatuses(page: Page): Promise<void> {
    const results: { username: string; followStatus: string }[] = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return [];

      const usernamePattern = /^\/([a-zA-Z0-9._]+)\/$/;
      const reserved = new Set([
        'explore', 'accounts', 'reels', 'direct', 'stories', 'p', 'tv',
      ]);
      const entries: { username: string; followStatus: string }[] = [];
      const seen = new Set<string>();

      const anchors = dialog.querySelectorAll('a[href^="/"]');

      for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const match = href.match(usernamePattern);
        if (!match || reserved.has(match[1])) continue;

        const username = match[1];
        if (seen.has(username)) continue;
        seen.add(username);

        // Walk up to find the user row container that also has a button
        let container = anchor.parentElement;
        let followStatus = 'none';
        let depth = 0;

        while (container && container !== dialog && depth < 8) {
          const buttons = container.querySelectorAll('button');
          if (buttons.length > 0) {
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text === 'following' || text === 'requested') {
                followStatus = 'following';
                break;
              }
              if (text === 'follow' || text === 'follow back') {
                followStatus = 'follow';
                break;
              }
            }
            if (followStatus !== 'none') break;
          }
          container = container.parentElement;
          depth++;
        }

        // Check aria-label on buttons if text detection failed
        if (followStatus === 'none') {
          let checkEl = anchor.parentElement;
          let checkDepth = 0;
          while (checkEl && checkEl !== dialog && checkDepth < 8) {
            const btns = checkEl.querySelectorAll('button');
            for (const btn of btns) {
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
              if (ariaLabel.includes('following') || ariaLabel.includes('unfollow')) {
                followStatus = 'following';
                break;
              }
              if (ariaLabel.includes('follow')) {
                followStatus = 'follow';
                break;
              }
            }
            if (followStatus !== 'none') break;
            checkEl = checkEl.parentElement;
            checkDepth++;
          }
        }

        entries.push({ username, followStatus });
      }

      return entries;
    });

    const now = new Date().toISOString();
    for (const { username, followStatus } of results) {
      if (!this.collectedUsers.has(username)) {
        this.collectedUsers.set(username, { username, scrapedAt: now });
      }

      if (followStatus === 'following') {
        this.excludedUsernames.add(username);
      }
    }
  }

  // ── Profile Stats ──────────────────────────────────────────────────────────

  /**
   * Visits a user's profile and extracts their following/follower counts.
   */
  private async getProfileStats(page: Page, username: string): Promise<ProfileStats | null> {
    try {
      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'networkidle2',
        timeout: 20000,
      });
      await sleep(randomBetween(...this.timing.navigationDelay));

      await page.waitForSelector('header', { timeout: 10000 });
      await sleep(randomBetween(300, 600));

      const stats = await page.evaluate((targetUser: string) => {
        const parseCount = (str: string): number => {
          str = str.trim().replace(/,/g, '');
          if (str.endsWith('K') || str.endsWith('k')) {
            return Math.round(parseFloat(str) * 1000);
          }
          if (str.endsWith('M') || str.endsWith('m')) {
            return Math.round(parseFloat(str) * 1000000);
          }
          return parseInt(str, 10) || 0;
        };

        // Strategy 1: Meta description tag
        const metaEl = document.querySelector('meta[name="description"]');
        if (metaEl) {
          const content = metaEl.getAttribute('content') || '';
          const followersMatch = content.match(/([\d,.]+[KkMm]?)\s+Followers/i);
          const followingMatch = content.match(/([\d,.]+[KkMm]?)\s+Following/i);
          if (followersMatch && followingMatch) {
            return {
              followerCount: parseCount(followersMatch[1]),
              followingCount: parseCount(followingMatch[1]),
            };
          }
        }

        // Strategy 2: Stats links in header
        const followerLink = document.querySelector(`a[href='/${targetUser}/followers/']`);
        const followingLink = document.querySelector(`a[href='/${targetUser}/following/']`);
        const extractNumber = (el: Element | null): number => {
          if (!el) return -1;
          const text = el.textContent || '';
          const numMatch = text.match(/([\d,.]+[KkMm]?)/);
          if (!numMatch) return -1;
          return parseCount(numMatch[1]);
        };

        const fc = extractNumber(followerLink);
        const fgc = extractNumber(followingLink);
        if (fc >= 0 && fgc >= 0) return { followerCount: fc, followingCount: fgc };

        // Strategy 3: title attributes on stat elements
        const headerSection = document.querySelector('header section');
        if (headerSection) {
          const statsEls = headerSection.querySelectorAll('a, span');
          const numbers: number[] = [];
          for (const el of statsEls) {
            const title = el.getAttribute('title');
            if (title) {
              const num = parseInt(title.replace(/,/g, ''), 10);
              if (!isNaN(num)) numbers.push(num);
            }
            const innerSpan = el.querySelector('span');
            if (innerSpan) {
              const spanTitle = innerSpan.getAttribute('title');
              if (spanTitle) {
                const num = parseInt(spanTitle.replace(/,/g, ''), 10);
                if (!isNaN(num)) numbers.push(num);
              }
            }
          }
          // Instagram header order: posts, followers, following
          if (numbers.length >= 3) {
            return { followerCount: numbers[1], followingCount: numbers[2] };
          }
          if (numbers.length === 2) {
            return { followerCount: numbers[0], followingCount: numbers[1] };
          }
        }

        // Strategy 4: Parse visible text near "followers" / "following"
        const headerEl = document.querySelector('header');
        if (headerEl) {
          const allText = (headerEl as HTMLElement).innerText || '';
          const lines = allText.split('\n').map((l: string) => l.trim()).filter(Boolean);
          let followerVal = -1;
          let followingVal = -1;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].toLowerCase();
            if (line.includes('followers') || line.includes('follower')) {
              const numMatch = lines[i].match(/([\d,.]+)/);
              if (numMatch) followerVal = parseInt(numMatch[1].replace(/,/g, ''), 10);
            }
            if (line.includes('following')) {
              const numMatch = lines[i].match(/([\d,.]+)/);
              if (numMatch) followingVal = parseInt(numMatch[1].replace(/,/g, ''), 10);
            }
          }
          if (followerVal >= 0 && followingVal >= 0) {
            return { followerCount: followerVal, followingCount: followingVal };
          }
        }

        return null;
      }, username);

      return stats;
    } catch (err: any) {
      logger.warn(`Failed to get profile stats for @${username}: ${err.message}`);
      return null;
    }
  }
}
