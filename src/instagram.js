const fs = require('fs');
const puppeteer = require('puppeteer');
const logger = require('./utils/logger');

const INSTAGRAM_BASE = 'https://www.instagram.com';

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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    this.page = await this.browser.newPage();
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

    const followers = await this.page.evaluate(async () => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) {
        return [];
      }
      const scrollBox = Array.from(dialog.querySelectorAll('div')).find(
        (element) => element.scrollHeight > element.clientHeight,
      ) || dialog;
      const usernames = new Set();

      let lastHeight = 0;
      let lastSize = 0;
      let unchangedCount = 0;
      while (unchangedCount < 5) {
        scrollBox.scrollTop = scrollBox.scrollHeight;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const newHeight = scrollBox.scrollHeight;
        dialog.querySelectorAll('a').forEach((anchor) => {
          const href = anchor.getAttribute('href') || '';
          if (href.startsWith('/') && href.length > 1) {
            const handle = href.replace(/\//g, '');
            if (handle) {
              usernames.add(handle);
            }
          }
        });
        const size = usernames.size;
        if (newHeight === lastHeight && size === lastSize) {
          unchangedCount += 1;
        } else {
          unchangedCount = 0;
          lastHeight = newHeight;
          lastSize = size;
        }
      }

      return Array.from(usernames);
    });

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
      const link = Array.from(header.querySelectorAll('a')).find((anchor) => {
        return anchor.href.includes('/following');
      });
      if (link) {
        const span = link.querySelector('span');
        const value = span?.getAttribute('title') || span?.textContent;
        const parsed = extractNumber(value);
        if (parsed !== null) {
          return parsed;
        }
      }

      const listItems = Array.from(header.querySelectorAll('ul li'));
      for (const item of listItems) {
        const text = item.textContent || '';
        if (!text.toLowerCase().includes('following')) {
          continue;
        }
        const span = item.querySelector('span[title]') || item.querySelector('span');
        const parsed = extractNumber(span?.getAttribute('title') || span?.textContent);
        if (parsed !== null) {
          return parsed;
        }
      }

      const meta = document.querySelector('meta[property=\"og:description\"]');
      if (meta) {
        const match = meta.getAttribute('content')?.match(/([\\d,.]+)\\s+Following/i);
        const parsed = extractNumber(match ? match[1] : null);
        if (parsed !== null) {
          return parsed;
        }
      }

      return null;
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
