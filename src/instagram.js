const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('./utils/logger');

const INSTAGRAM_BASE = 'https://www.instagram.com';

puppeteer.use(StealthPlugin());

class InstagramClient {
  constructor({ cookiesPath, headless, slowMo }) {
    this.cookiesPath = cookiesPath;
    this.headless = headless;
    this.slowMo = slowMo;
    this.browser = null;
    this.page = null;
  }

  async launch() {
    this.browser = await puppeteer.launch({
      headless: this.headless,
      slowMo: this.slowMo,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
    await this.page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await this.page.setViewport({ width: 1280, height: 800 });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async saveCookies() {
    const cookies = await this.page.cookies();
    fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies, null, 2));
  }

  async loadCookies() {
    if (!fs.existsSync(this.cookiesPath)) {
      return false;
    }
    const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf-8'));
    await this.page.setCookie(...cookies);
    return true;
  }

  async isLoggedIn() {
    await this.page.goto(INSTAGRAM_BASE, { waitUntil: 'networkidle2' });
    return !this.page.url().includes('/accounts/login');
  }

  async login() {
    logger.info('Waiting for manual Instagram login in the opened browser.');
    await this.page.goto(`${INSTAGRAM_BASE}/accounts/login/`, { waitUntil: 'networkidle2' });
    await this.page.waitForFunction(
      () => {
        const path = window.location.pathname;
        return !path.startsWith('/accounts/login') && !path.startsWith('/challenge');
      },
      { polling: 1000, timeout: 0 },
    );

    const loggedIn = await this.isLoggedIn();
    if (!loggedIn) {
      throw new Error('Manual login did not complete successfully.');
    }
    await this.saveCookies();
  }

  async ensureAuthenticated() {
    await this.launch();
    const hasCookies = await this.loadCookies();
    if (hasCookies) {
      const loggedIn = await this.isLoggedIn();
      if (loggedIn) {
        logger.info('Authenticated using saved cookies.');
        return;
      }
      logger.warn('Saved cookies invalid; starting new login.');
    }

    await this.close();

    this.headless = false;
    await this.launch();
    await this.login();
  }

  async fetchFollowers(target) {
    const url = `${INSTAGRAM_BASE}/${target}/`;
    await this.page.goto(url, { waitUntil: 'networkidle2' });
    const followersLink = await this.page.$(`a[href='/${target}/followers/']`);
    if (!followersLink) {
      throw new Error('Unable to access followers list. Target may be private.');
    }
    await followersLink.click();
    await this.page.waitForSelector('div[role="dialog"]', { timeout: 15000 });

    const dialog = await this.page.waitForSelector('div[role="dialog"]', { timeout: 15000 });
    const scrollBoxHandle = await this.page.evaluateHandle((dialogEl) => {
      const candidates = Array.from(dialogEl.querySelectorAll('div'));
      const scrollable = candidates
        .map((element) => ({
          element,
          style: window.getComputedStyle(element),
        }))
        .filter(
          ({ element, style }) =>
            element.scrollHeight > element.clientHeight &&
            ['auto', 'scroll'].includes(style.overflowY),
        )
        .sort((a, b) => b.element.scrollHeight - a.element.scrollHeight)[0];
      return (scrollable && scrollable.element) || dialogEl;
    }, dialog);

    let unchangedCount = 0;
    let lastSize = 0;
    while (unchangedCount < 5) {
      const usernames = await this.page.evaluate((dialogEl) => {
        const handles = new Set();
        const anchors = dialogEl.querySelectorAll('a[href^="/"]');
        anchors.forEach((anchor) => {
          const href = anchor.getAttribute('href') || '';
          if (/^\\/[^/]+\\/$/.test(href)) {
            const handle = href.replace(/\//g, '');
            if (handle) {
              handles.add(handle);
            }
          }
        });
        return Array.from(handles);
      }, dialog);

      if (usernames.length === lastSize) {
        unchangedCount += 1;
      } else {
        unchangedCount = 0;
        lastSize = usernames.length;
      }

      await this.page.evaluate((scrollEl) => {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }, scrollBoxHandle);
      await this.page.waitForTimeout(1000);
    }

    const followers = await this.page.evaluate((dialogEl) => {
      const handles = new Set();
      const anchors = dialogEl.querySelectorAll('a[href^="/"]');
      anchors.forEach((anchor) => {
        const href = anchor.getAttribute('href') || '';
        if (/^\\/[^/]+\\/$/.test(href)) {
          const handle = href.replace(/\//g, '');
          if (handle) {
            handles.add(handle);
          }
        }
      });
      return Array.from(handles);
    }, dialog);

    return followers;
  }

  async fetchFollowingCount(username) {
    await this.page.goto(`${INSTAGRAM_BASE}/${username}/`, { waitUntil: 'networkidle2' });
    await this.page.waitForSelector('header', { timeout: 15000 });
    const count = await this.page.evaluate(() => {
      const extractNumber = (value) => {
        if (!value) {
          return null;
        }
        const parsed = parseInt(value.replace(/[^\d]/g, ''), 10);
        return Number.isFinite(parsed) ? parsed : null;
      };

      const header = document.querySelector('header');
      if (!header) {
        return null;
      }

      const listItems = Array.from(header.querySelectorAll('ul li'));
      const followingItem = listItems.find((item) =>
        (item.textContent || '').toLowerCase().includes('following'),
      );
      if (!followingItem) {
        return null;
      }

      const spans = Array.from(followingItem.querySelectorAll('span'));
      const labelSpan = spans.find((span) =>
        (span.textContent || '').toLowerCase().includes('following'),
      );
      let numberSpan = null;
      if (labelSpan) {
        const labelIndex = spans.indexOf(labelSpan);
        if (labelIndex > 0) {
          numberSpan = spans[labelIndex - 1];
        }
      }
      if (!numberSpan) {
        numberSpan =
          followingItem.querySelector('span[title]') ||
          spans.find((span) => /\\d/.test(span.textContent || ''));
      }

      const value = numberSpan?.getAttribute('title') || numberSpan?.textContent;
      return extractNumber(value);
    });

    if (!Number.isFinite(count)) {
      throw new Error(`Unable to parse following count for ${username}.`);
    }
    return count;
  }

  async followUser(username) {
    await this.page.goto(`${INSTAGRAM_BASE}/${username}/`, { waitUntil: 'networkidle2' });
    await this.page.waitForSelector('header', { timeout: 15000 });
    const button = await this.page.$('header button');
    if (!button) {
      throw new Error(`Follow button not found for ${username}.`);
    }
    const label = await this.page.evaluate((btn) => btn.textContent, button);
    if (label && ['following', 'requested'].some((value) => label.toLowerCase().includes(value))) {
      logger.info(`Already following @${username}.`);
      return false;
    }
    await button.click();
    await this.page.waitForTimeout(2000);
    return true;
  }

  async unfollowUser(username) {
    await this.page.goto(`${INSTAGRAM_BASE}/${username}/`, { waitUntil: 'networkidle2' });
    await this.page.waitForSelector('header', { timeout: 15000 });
    const button = await this.page.$('header button');
    if (!button) {
      throw new Error(`Unfollow button not found for ${username}.`);
    }
    const label = await this.page.evaluate((btn) => btn.textContent, button);
    if (!label || !label.toLowerCase().includes('following')) {
      logger.info(`Already not following @${username}.`);
      return false;
    }
    await button.click();
    await this.page.waitForTimeout(1000);
    await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const confirm = buttons.find((btn) => btn.textContent && btn.textContent.trim() === 'Unfollow');
      if (confirm) {
        confirm.click();
      }
    });
    await this.page.waitForTimeout(2000);
    return true;
  }
}

module.exports = InstagramClient;
