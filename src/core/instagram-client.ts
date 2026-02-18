import * as fs from 'fs';
import * as logger from '../utils/logger';
import { sleep, randomBetween } from '../utils/humanize';

const INSTAGRAM_BASE = 'https://www.instagram.com';

type Browser = import('puppeteer').Browser;
type Page = import('puppeteer').Page;

export class InstagramClient {
  private cookiesPath: string;
  private headless: boolean;
  private slowMo: number;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private loggedInUser: string | null = null;

  constructor(opts: { cookiesPath: string; headless: boolean; slowMo: number }) {
    this.cookiesPath = opts.cookiesPath;
    this.headless = opts.headless;
    this.slowMo = opts.slowMo;
  }

  async launch(): Promise<void> {
    // Dynamic import to avoid bundling puppeteer
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    this.browser = await puppeteer.launch({
      headless: this.headless,
      slowMo: this.slowMo,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    this.page = await this.browser!.newPage();

    await this.page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await this.page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await this.page.setViewport({ width: 1280, height: 800 });

    logger.info('Browser launched.');
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      logger.info('Browser closed.');
    }
  }

  async saveCookies(): Promise<void> {
    if (!this.page) return;
    const cookies = await this.page.cookies();
    fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies, null, 2));
    logger.debug('Cookies saved.');
  }

  async loadCookies(): Promise<boolean> {
    if (!fs.existsSync(this.cookiesPath)) return false;
    const raw = fs.readFileSync(this.cookiesPath, 'utf-8');
    const cookies = JSON.parse(raw);
    if (!this.page) return false;
    await this.page.setCookie(...cookies);
    logger.debug('Cookies loaded.');
    return true;
  }

  async isLoggedIn(): Promise<boolean> {
    if (!this.page) return false;
    await this.page.goto(INSTAGRAM_BASE, { waitUntil: 'networkidle2', timeout: 30000 });
    const url = this.page.url();
    return !url.includes('/accounts/login');
  }

  async login(): Promise<void> {
    if (!this.page) throw new Error('Browser not launched.');
    logger.info('Waiting for manual login in the browser window...');
    await this.page.goto(`${INSTAGRAM_BASE}/accounts/login/`, { waitUntil: 'networkidle2' });

    // Wait indefinitely for user to complete login (including 2FA)
    await this.page.waitForFunction(
      () => {
        const path = window.location.pathname;
        return !path.startsWith('/accounts/login') && !path.startsWith('/challenge');
      },
      { polling: 1000, timeout: 0 },
    );

    // Give the page a moment to settle after redirect
    await sleep(3000);

    const loggedIn = await this.isLoggedIn();
    if (!loggedIn) throw new Error('Login did not complete successfully.');

    await this.saveCookies();
    logger.info('Login successful. Cookies saved.');
  }

  async ensureAuthenticated(): Promise<void> {
    await this.launch();
    const hasCookies = await this.loadCookies();

    if (hasCookies) {
      const loggedIn = await this.isLoggedIn();
      if (loggedIn) {
        logger.info('Authenticated via saved cookies.');
        return;
      }
      logger.warn('Saved cookies are invalid. Starting fresh login.');
    }

    // Close headless browser and relaunch visible for manual login
    await this.close();
    this.headless = false;
    await this.launch();
    await this.login();
  }

  async getLoggedInUsername(): Promise<string | null> {
    if (this.loggedInUser) return this.loggedInUser;
    if (!this.page) return null;

    // Ensure we're on an Instagram page
    const url = this.page.url();
    if (!url.includes('instagram.com')) {
      await this.page.goto(INSTAGRAM_BASE, { waitUntil: 'networkidle2', timeout: 30000 });
    }

    this.loggedInUser = await this.page.evaluate(() => {
      // Strategy 1: _sharedData (available on many Instagram page loads)
      try {
        const sd = (window as any)._sharedData;
        if (sd?.config?.viewer?.username) return sd.config.viewer.username as string;
      } catch {}

      // Strategy 2: Find profile link in sidebar that contains a profile picture
      try {
        const usernamePattern = /^\/([a-zA-Z0-9._]+)\/$/;
        const reserved = new Set([
          'explore', 'accounts', 'reels', 'direct', 'stories',
          'p', 'tv', 'about', 'privacy', 'terms', 'legal', 'api',
        ]);
        const allLinks = Array.from(document.querySelectorAll('a[href^="/"]'));
        for (const link of allLinks) {
          const href = link.getAttribute('href') || '';
          const match = href.match(usernamePattern);
          if (!match || reserved.has(match[1])) continue;
          const img = link.querySelector('img');
          if (img) {
            const alt = (img.getAttribute('alt') || '').toLowerCase();
            if (alt.includes('profile picture')) {
              return match[1];
            }
          }
        }
      } catch {}

      return null;
    });

    if (this.loggedInUser) {
      logger.info(`Detected logged-in user: @${this.loggedInUser}`);
    } else {
      logger.warn('Could not detect logged-in username. Self-filtering will rely on DOM detection.');
    }

    return this.loggedInUser;
  }

  getPage(): Page | null {
    return this.page;
  }

  getBrowser(): Browser | null {
    return this.browser;
  }
}
