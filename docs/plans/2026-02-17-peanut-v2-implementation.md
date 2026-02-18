# Peanut v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite Peanut as a TypeScript Electron app with hybrid Puppeteer+API-intercept Instagram automation, chunked follower scraping with resume, configurable rate limiting, and a polished Linear-style UI with FontAwesome icons.

**Architecture:** TypeScript compiled with esbuild. Electron main process manages Puppeteer automation engine. Renderer process is vanilla TS with FontAwesome 6 Free. State persisted as JSON. Instagram data extracted by intercepting GraphQL API responses while Puppeteer handles human-like browser navigation.

**Tech Stack:** TypeScript, Electron 31, Puppeteer 22 + stealth plugin, esbuild, FontAwesome 6 Free

---

## Phase 1: Project Scaffolding & Build System

### Task 1: Initialize TypeScript + esbuild build system

**Files:**
- Create: `tsconfig.json`
- Create: `esbuild.config.mjs`
- Modify: `package.json`

**Step 1: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node",
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 2: Create esbuild.config.mjs**

```javascript
import { build } from 'esbuild';
import { existsSync, mkdirSync, cpSync } from 'fs';
import path from 'path';

const isDev = process.argv.includes('--dev');

// Ensure dist directory exists
if (!existsSync('dist')) mkdirSync('dist', { recursive: true });

// Main process
await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: 'dist/main',
  external: ['electron', 'puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
  sourcemap: isDev,
  minify: !isDev,
  format: 'cjs',
});

// Renderer process
await build({
  entryPoints: ['src/renderer/app.ts'],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  outdir: 'dist/renderer',
  sourcemap: isDev,
  minify: !isDev,
  format: 'iife',
});

// Copy static assets
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles', 'dist/renderer/styles', { recursive: true });

// Copy FontAwesome assets
if (existsSync('node_modules/@fortawesome/fontawesome-free')) {
  if (!existsSync('dist/renderer/vendor/fontawesome')) {
    mkdirSync('dist/renderer/vendor/fontawesome', { recursive: true });
  }
  cpSync(
    'node_modules/@fortawesome/fontawesome-free/css/all.min.css',
    'dist/renderer/vendor/fontawesome/all.min.css'
  );
  cpSync(
    'node_modules/@fortawesome/fontawesome-free/webfonts',
    'dist/renderer/vendor/fontawesome/webfonts',
    { recursive: true }
  );
}

console.log('Build complete.');
```

**Step 3: Update package.json**

```json
{
  "name": "peanut",
  "version": "2.0.0",
  "description": "Instagram follow/unfollow growth automation with safe rate limiting.",
  "main": "dist/main/main.js",
  "type": "commonjs",
  "scripts": {
    "build": "node esbuild.config.mjs",
    "build:dev": "node esbuild.config.mjs --dev",
    "start": "npm run build && electron dist/main/main.js",
    "dev": "npm run build:dev && electron dist/main/main.js",
    "test": "jest"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@fortawesome/fontawesome-free": "^6.5.0",
    "electron": "^31.2.1",
    "puppeteer": "^22.8.2",
    "puppeteer-extra": "^3.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2"
  },
  "devDependencies": {
    "esbuild": "^0.20.0",
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "@types/jest": "^29.5.0"
  },
  "license": "MIT"
}
```

**Step 4: Install dependencies**

Run: `cd /Users/owengregson/Documents/Peanut && npm install`
Expected: Successful install with new deps (esbuild, typescript, @fortawesome/fontawesome-free, @types/*)

**Step 5: Verify build runs (will fail - no source yet, that's fine)**

Run: `npm run build 2>&1 || echo "Expected failure - no source files yet"`

**Step 6: Commit**

```bash
git add tsconfig.json esbuild.config.mjs package.json package-lock.json
git commit -m "chore: scaffold TypeScript + esbuild build system for Peanut v2"
```

---

### Task 2: Create directory structure and placeholder files

**Files:**
- Create: `src/main/main.ts`
- Create: `src/main/preload.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/app.ts`
- Create: `src/renderer/styles/app.css`
- Create: `src/core/instagram-client.ts`
- Create: `src/core/scraper.ts`
- Create: `src/core/actions.ts`
- Create: `src/core/rate-limiter.ts`
- Create: `src/state/state.ts`
- Create: `src/state/scrape-cursor.ts`
- Create: `src/utils/logger.ts`
- Create: `src/utils/humanize.ts`
- Create: `src/utils/time.ts`
- Create: `src/types.ts`

**Step 1: Create the shared types file**

```typescript
// src/types.ts

// ── Settings ──────────────────────────────────────────────────────────────────

export interface Settings {
  target: string;
  headless: boolean;
  dryRun: boolean;
  maxActionsPerDay: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  activeHoursStart: number;
  activeHoursEnd: number;
  jitterPercent: number;
  scrapeChunkSize: number;
  unfollowAfterHours: number;
  slowMo: number;
}

export const DEFAULT_SETTINGS: Settings = {
  target: '',
  headless: true,
  dryRun: false,
  maxActionsPerDay: 20,
  minDelayMinutes: 3,
  maxDelayMinutes: 7,
  activeHoursStart: 8,
  activeHoursEnd: 22,
  jitterPercent: 30,
  scrapeChunkSize: 200,
  unfollowAfterHours: 24,
  slowMo: 0,
};

// ── Follower Data ─────────────────────────────────────────────────────────────

export interface FollowerEntry {
  username: string;
  userId?: string;
  fullName?: string;
  isVerified?: boolean;
  scrapedAt: string;
}

// ── Scrape Cursor ─────────────────────────────────────────────────────────────

export interface ScrapeCursor {
  targetUsername: string;
  totalCollected: number;
  lastUserId: string;
  collectedUsernames: string[];
  isComplete: boolean;
  lastScrapedAt: string;
  endCursor: string;
  hasNextPage: boolean;
}

// ── Scheduled Actions ─────────────────────────────────────────────────────────

export interface ScheduledAction {
  username: string;
  scheduledAt: string;
}

export interface HistoryEntry {
  username: string;
  followedAt: string;
}

// ── App State ─────────────────────────────────────────────────────────────────

export interface AppState {
  target: string;
  generatedAt: string;
  scrapeCursor: ScrapeCursor | null;
  followerList: FollowerEntry[];
  nextFollowIndex: number;
  followQueue: ScheduledAction[];
  followHistory: HistoryEntry[];
  pendingUnfollows: ScheduledAction[];
  lastDailyPlan: string | null;
}

// ── Bot Status (sent to renderer) ─────────────────────────────────────────────

export interface BotStatus {
  running: boolean;
  busy: boolean;
  lastAction: string;
  target: string;
  followerCount: number;
  nextFollowIndex: number;
  queuedFollows: number;
  pendingUnfollows: number;
  nextFollowAt: string | null;
  nextUnfollowAt: string | null;
  scrapeProgress: {
    totalCollected: number;
    isComplete: boolean;
    isActive: boolean;
  } | null;
}

// ── Log Entry (sent to renderer) ──────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

// ── IPC Channel Types ─────────────────────────────────────────────────────────

export interface PeanutAPI {
  getSettings(): Promise<Settings>;
  updateSettings(settings: Partial<Settings>): Promise<Settings>;
  getStatus(): Promise<BotStatus>;
  getFollowerList(): Promise<{ followerList: FollowerEntry[]; nextFollowIndex: number }>;
  startBot(): Promise<void>;
  stopBot(): Promise<void>;
  startScraping(): Promise<void>;
  clearSession(): Promise<void>;
  getLogs(): Promise<LogEntry[]>;
  onLog(callback: (entry: LogEntry) => void): void;
  onStatus(callback: (status: BotStatus) => void): void;
}
```

**Step 2: Create all placeholder files with minimal exports**

Create each file with a placeholder comment and any necessary type imports. Every file should compile.

`src/utils/time.ts`:
```typescript
export const startOfDay = (date: Date): Date => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

export const isSameDay = (a: Date, b: Date): boolean =>
  startOfDay(a).getTime() === startOfDay(b).getTime();
```

`src/utils/logger.ts`:
```typescript
import { LogEntry } from '../types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = 'info';
let logBuffer: LogEntry[] = [];
let onLogCallback: ((entry: LogEntry) => void) | null = null;
const MAX_BUFFER = 500;

export const setLevel = (level: LogLevel): void => {
  currentLevel = level;
};

export const setLogCallback = (cb: (entry: LogEntry) => void): void => {
  onLogCallback = cb;
};

export const getLogBuffer = (): LogEntry[] => [...logBuffer];

const log = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
  if (LEVEL_VALUES[level] < LEVEL_VALUES[currentLevel]) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    meta,
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer = logBuffer.slice(-MAX_BUFFER);

  if (onLogCallback) onLogCallback(entry);

  const prefix = `[${entry.timestamp}] ${level.toUpperCase()}`;
  const output = meta ? `${prefix} ${message} ${JSON.stringify(meta)}` : `${prefix} ${message}`;
  if (level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
};

export const debug = (message: string, meta?: Record<string, unknown>): void => log('debug', message, meta);
export const info = (message: string, meta?: Record<string, unknown>): void => log('info', message, meta);
export const warn = (message: string, meta?: Record<string, unknown>): void => log('warn', message, meta);
export const error = (message: string, meta?: Record<string, unknown>): void => log('error', message, meta);
```

`src/utils/humanize.ts`:
```typescript
export const randomBetween = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export const addJitter = (baseMs: number, jitterPercent: number): number => {
  const factor = 1 + (Math.random() * 2 - 1) * (jitterPercent / 100);
  return Math.round(baseMs * factor);
};

export const humanDelay = (minMs: number, maxMs: number, jitterPercent: number): number => {
  const base = randomBetween(minMs, maxMs);
  return addJitter(base, jitterPercent);
};

export const isWithinActiveHours = (start: number, end: number): boolean => {
  const hour = new Date().getHours();
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // Handles overnight ranges like 22-6
  return hour >= start || hour < end;
};

export const msUntilActiveHours = (start: number): number => {
  const now = new Date();
  const target = new Date(now);
  target.setHours(start, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
```

`src/core/rate-limiter.ts`:
```typescript
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
```

`src/state/state.ts`:
```typescript
import * as fs from 'fs';
import { AppState } from '../types';

export const createEmptyState = (target: string): AppState => ({
  target,
  generatedAt: new Date().toISOString(),
  scrapeCursor: null,
  followerList: [],
  nextFollowIndex: 0,
  followQueue: [],
  followHistory: [],
  pendingUnfollows: [],
  lastDailyPlan: null,
});

export const loadState = (filePath: string, target: string): AppState => {
  if (!fs.existsSync(filePath)) {
    return createEmptyState(target);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<AppState>;
  return {
    ...createEmptyState(target),
    ...parsed,
    target: target || parsed.target || '',
  };
};

export const saveState = (filePath: string, state: AppState): void => {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
};
```

`src/state/scrape-cursor.ts`:
```typescript
import * as fs from 'fs';
import { ScrapeCursor } from '../types';

export const createEmptyCursor = (targetUsername: string): ScrapeCursor => ({
  targetUsername,
  totalCollected: 0,
  lastUserId: '',
  collectedUsernames: [],
  isComplete: false,
  lastScrapedAt: new Date().toISOString(),
  endCursor: '',
  hasNextPage: true,
});

export const loadCursor = (filePath: string, targetUsername: string): ScrapeCursor => {
  if (!fs.existsSync(filePath)) {
    return createEmptyCursor(targetUsername);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<ScrapeCursor>;
  if (parsed.targetUsername !== targetUsername) {
    return createEmptyCursor(targetUsername);
  }
  return { ...createEmptyCursor(targetUsername), ...parsed };
};

export const saveCursor = (filePath: string, cursor: ScrapeCursor): void => {
  fs.writeFileSync(filePath, JSON.stringify(cursor, null, 2));
};
```

`src/core/instagram-client.ts` (placeholder):
```typescript
import * as fs from 'fs';
import * as logger from '../utils/logger';

const INSTAGRAM_BASE = 'https://www.instagram.com';

// Puppeteer types - import at runtime to avoid bundling issues
type PuppeteerBrowser = any;
type PuppeteerPage = any;

export class InstagramClient {
  private cookiesPath: string;
  private headless: boolean;
  private slowMo: number;
  private browser: PuppeteerBrowser | null = null;
  private page: PuppeteerPage | null = null;

  constructor(opts: { cookiesPath: string; headless: boolean; slowMo: number }) {
    this.cookiesPath = opts.cookiesPath;
    this.headless = opts.headless;
    this.slowMo = opts.slowMo;
  }

  // Will be implemented in Task 4
  async launch(): Promise<void> { /* placeholder */ }
  async close(): Promise<void> { /* placeholder */ }
  async saveCookies(): Promise<void> { /* placeholder */ }
  async loadCookies(): Promise<boolean> { return false; }
  async isLoggedIn(): Promise<boolean> { return false; }
  async login(): Promise<void> { /* placeholder */ }
  async ensureAuthenticated(): Promise<void> { /* placeholder */ }
  getPage(): PuppeteerPage | null { return this.page; }
}
```

`src/core/scraper.ts` (placeholder):
```typescript
import { FollowerEntry, ScrapeCursor } from '../types';

export class FollowerScraper {
  // Will be implemented in Task 5
  async scrapeChunk(
    _page: any,
    _targetUsername: string,
    _cursor: ScrapeCursor,
    _chunkSize: number,
  ): Promise<{ entries: FollowerEntry[]; cursor: ScrapeCursor }> {
    return { entries: [], cursor: {} as ScrapeCursor };
  }
}
```

`src/core/actions.ts` (placeholder):
```typescript
export class InstagramActions {
  // Will be implemented in Task 6
  async followUser(_page: any, _username: string): Promise<boolean> { return false; }
  async unfollowUser(_page: any, _username: string): Promise<boolean> { return false; }
}
```

`src/main/preload.ts`:
```typescript
import { contextBridge, ipcRenderer } from 'electron';
import type { PeanutAPI } from '../types';

const api: PeanutAPI = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getFollowerList: () => ipcRenderer.invoke('followers:get'),
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  startScraping: () => ipcRenderer.invoke('bot:scrape'),
  clearSession: () => ipcRenderer.invoke('bot:clear'),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  onLog: (callback) => {
    ipcRenderer.on('log:entry', (_event, entry) => callback(entry));
  },
  onStatus: (callback) => {
    ipcRenderer.on('status:update', (_event, status) => callback(status));
  },
};

contextBridge.exposeInMainWorld('peanut', api);
```

`src/main/main.ts` (placeholder):
```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#09090b',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
};

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

`src/renderer/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Peanut</title>
    <link rel="stylesheet" href="vendor/fontawesome/all.min.css" />
    <link rel="stylesheet" href="styles/app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="app.js"></script>
  </body>
</html>
```

`src/renderer/app.ts` (placeholder):
```typescript
// Will be implemented in Phase 3 (UI)
document.getElementById('root')!.innerHTML = '<div class="app-loading"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading Peanut...</span></div>';
```

`src/renderer/styles/app.css` (placeholder - just enough to show loading):
```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #09090b; color: #fafafa; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif; }
.app-loading { display: flex; align-items: center; justify-content: center; height: 100vh; gap: 12px; color: #71717a; font-size: 14px; }
.app-loading i { font-size: 18px; }
```

**Step 3: Verify build succeeds**

Run: `cd /Users/owengregson/Documents/Peanut && npm run build`
Expected: "Build complete." with files in dist/

**Step 4: Verify app launches**

Run: `npm run dev`
Expected: Electron window opens showing loading spinner. Close it manually.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: scaffold Peanut v2 TypeScript project structure with all modules"
```

---

## Phase 2: Core Automation Engine

### Task 3: Implement Instagram Client (authentication)

**Files:**
- Modify: `src/core/instagram-client.ts`

**Step 1: Implement the full Instagram client with Puppeteer launch, cookie management, and manual login flow**

Replace the placeholder `src/core/instagram-client.ts` with the full implementation:

```typescript
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

  getPage(): Page | null {
    return this.page;
  }

  getBrowser(): Browser | null {
    return this.browser;
  }
}
```

**Step 2: Build and verify compilation**

Run: `npm run build`
Expected: Build complete without errors.

**Step 3: Commit**

```bash
git add src/core/instagram-client.ts
git commit -m "feat: implement Instagram client with Puppeteer auth and cookie management"
```

---

### Task 4: Implement follower scraper with API intercept

**Files:**
- Modify: `src/core/scraper.ts`

**Step 1: Implement the full scraper**

This is the most critical piece. It intercepts Instagram's GraphQL API responses when the followers dialog is open and scrolling.

```typescript
import { FollowerEntry, ScrapeCursor } from '../types';
import { createEmptyCursor } from '../state/scrape-cursor';
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
}

interface GraphQLFollowerEdge {
  node: GraphQLFollowerNode;
}

interface GraphQLPageInfo {
  has_next_page: boolean;
  end_cursor: string;
}

export class FollowerScraper {
  private collectedUsers: Map<string, FollowerEntry> = new Map();
  private pageInfo: GraphQLPageInfo = { has_next_page: true, end_cursor: '' };

  async scrapeChunk(
    page: Page,
    targetUsername: string,
    cursor: ScrapeCursor,
    chunkSize: number,
  ): Promise<{ entries: FollowerEntry[]; cursor: ScrapeCursor }> {
    // Restore previously collected users into our map
    this.collectedUsers = new Map();
    for (const uname of cursor.collectedUsernames) {
      this.collectedUsers.set(uname, {
        username: uname,
        scrapedAt: cursor.lastScrapedAt,
      });
    }

    const startCount = this.collectedUsers.size;
    const target = chunkSize;

    // Set up API response interceptor
    const responseHandler = this.createResponseInterceptor(page);

    // Navigate to target profile if not already there
    const currentUrl = page.url();
    if (!currentUrl.includes(`/${targetUsername}/`)) {
      await page.goto(`https://www.instagram.com/${targetUsername}/`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await sleep(randomBetween(1000, 2000));
    }

    // Open followers dialog
    if (!cursor.totalCollected || cursor.totalCollected === 0) {
      await this.openFollowersDialog(page, targetUsername);
    } else {
      // Re-open and scroll back to position
      await this.openFollowersDialog(page, targetUsername);
      logger.info(`Resuming scrape from position ${cursor.totalCollected}. Scrolling to catch up...`);
    }

    // Scroll and collect
    let unchangedCount = 0;
    let lastSize = this.collectedUsers.size;
    const maxUnchanged = 8;

    while (this.collectedUsers.size - startCount < target && unchangedCount < maxUnchanged) {
      // Scroll the dialog
      await this.scrollFollowersDialog(page);
      await sleep(randomBetween(800, 2500));

      if (this.collectedUsers.size === lastSize) {
        unchangedCount++;
      } else {
        unchangedCount = 0;
        lastSize = this.collectedUsers.size;
      }

      logger.debug(`Scraped ${this.collectedUsers.size} followers so far (${unchangedCount} unchanged rounds).`);
    }

    // Remove the interceptor
    responseHandler.remove();

    // Also scrape visible DOM as a fallback/supplement
    const domUsernames = await this.scrapeVisibleUsernames(page);
    const now = new Date().toISOString();
    for (const uname of domUsernames) {
      if (!this.collectedUsers.has(uname)) {
        this.collectedUsers.set(uname, { username: uname, scrapedAt: now });
      }
    }

    // Build results
    const allUsernames = Array.from(this.collectedUsers.keys());
    const newEntries = allUsernames
      .slice(startCount)
      .map((uname) => this.collectedUsers.get(uname)!);

    const isComplete = unchangedCount >= maxUnchanged || !this.pageInfo.has_next_page;

    const updatedCursor: ScrapeCursor = {
      targetUsername,
      totalCollected: allUsernames.length,
      lastUserId: this.pageInfo.end_cursor,
      collectedUsernames: allUsernames,
      isComplete,
      lastScrapedAt: now,
      endCursor: this.pageInfo.end_cursor,
      hasNextPage: this.pageInfo.has_next_page,
    };

    logger.info(
      `Scrape chunk complete: ${newEntries.length} new followers (${allUsernames.length} total). ` +
      `${isComplete ? 'Scraping complete.' : 'More available.'}`,
    );

    return { entries: newEntries, cursor: updatedCursor };
  }

  private createResponseInterceptor(page: Page): { remove: () => void } {
    const handler = async (response: HTTPResponse) => {
      try {
        const url = response.url();
        // Intercept Instagram GraphQL follower responses
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
          }
        }

        // Extract pagination info
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
          }
        }
      }
    } catch {
      // Not the format we expected
    }
  }

  private async openFollowersDialog(page: Page, targetUsername: string): Promise<void> {
    // Click the followers link
    const followersLink = await page.$(`a[href='/${targetUsername}/followers/']`);
    if (!followersLink) {
      // Try alternative selector
      const links = await page.$$('a[href*="followers"]');
      if (links.length > 0) {
        await links[0].click();
      } else {
        throw new Error('Could not find followers link on profile page.');
      }
    } else {
      await followersLink.click();
    }

    // Wait for dialog to appear
    await page.waitForSelector('div[role="dialog"]', { timeout: 15000 });
    await sleep(randomBetween(1000, 2000));
    logger.info('Followers dialog opened.');
  }

  private async scrollFollowersDialog(page: Page): Promise<void> {
    // Find the scrollable container inside the dialog
    await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) return;

      // Find the scrollable div
      const candidates = Array.from(dialog.querySelectorAll('div'));
      const scrollable = candidates
        .filter((el) => {
          const style = window.getComputedStyle(el);
          return (
            el.scrollHeight > el.clientHeight &&
            ['auto', 'scroll'].includes(style.overflowY)
          );
        })
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

      if (scrollable) {
        // Scroll by a random amount (not to bottom - more human-like)
        const scrollAmount = Math.floor(Math.random() * 400) + 200;
        scrollable.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    });
  }

  private async scrapeVisibleUsernames(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) return [];

      const usernames = new Set<string>();
      const anchors = dialog.querySelectorAll('a[href^="/"]');
      const usernamePattern = /^\/([a-zA-Z0-9._]+)\/$/;

      anchors.forEach((a) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(usernamePattern);
        if (match && match[1] !== 'explore' && match[1] !== 'accounts') {
          usernames.add(match[1]);
        }
      });

      return Array.from(usernames);
    });
  }
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build complete.

**Step 3: Commit**

```bash
git add src/core/scraper.ts
git commit -m "feat: implement follower scraper with API response intercept and chunked collection"
```

---

### Task 5: Implement follow/unfollow actions

**Files:**
- Modify: `src/core/actions.ts`

**Step 1: Implement follow and unfollow with human-like behavior**

```typescript
import * as logger from '../utils/logger';
import { sleep, randomBetween } from '../utils/humanize';

type Page = import('puppeteer').Page;

const INSTAGRAM_BASE = 'https://www.instagram.com';

export class InstagramActions {
  async followUser(page: Page, username: string, dryRun: boolean): Promise<boolean> {
    logger.info(`Attempting to follow @${username}...`);

    if (dryRun) {
      logger.info(`[DRY RUN] Would follow @${username}.`);
      return true;
    }

    await page.goto(`${INSTAGRAM_BASE}/${username}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await sleep(randomBetween(1000, 2000));

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
    await sleep(randomBetween(1500, 3000));

    logger.info(`Followed @${username}.`);
    return true;
  }

  async unfollowUser(page: Page, username: string, dryRun: boolean): Promise<boolean> {
    logger.info(`Attempting to unfollow @${username}...`);

    if (dryRun) {
      logger.info(`[DRY RUN] Would unfollow @${username}.`);
      return true;
    }

    await page.goto(`${INSTAGRAM_BASE}/${username}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await sleep(randomBetween(1000, 2000));

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

    await sleep(randomBetween(1500, 3000));
    logger.info(`Unfollowed @${username}.`);
    return true;
  }

  private async findProfileActionButton(page: Page): Promise<any> {
    // Instagram profile action buttons are in the header section
    // Try multiple selector strategies for resilience
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
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build complete.

**Step 3: Commit**

```bash
git add src/core/actions.ts
git commit -m "feat: implement follow/unfollow actions with human-like delays"
```

---

### Task 6: Implement the Bot Service (orchestrator)

**Files:**
- Create: `src/main/bot-service.ts`

**Step 1: Create the bot service that orchestrates everything**

```typescript
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

      const result = await this.scraper.scrapeChunk(
        page,
        this.settings.target,
        cursor,
        this.settings.scrapeChunkSize,
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
          const success = await this.actions.followUser(page, follow.username, this.settings.dryRun);
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
          const success = await this.actions.unfollowUser(page, unfollow.username, this.settings.dryRun);
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
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build complete.

**Step 3: Commit**

```bash
git add src/main/bot-service.ts
git commit -m "feat: implement BotService orchestrator with scraping, follow/unfollow, and scheduling"
```

---

### Task 7: Wire up Electron main process with IPC

**Files:**
- Modify: `src/main/main.ts`

**Step 1: Replace placeholder main.ts with full IPC wiring**

```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { BotService } from './bot-service';
import * as logger from '../utils/logger';
import { LogEntry } from '../types';

let mainWindow: BrowserWindow | null = null;
let botService: BotService | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#09090b',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
};

const registerIpc = (): void => {
  if (!botService) return;

  ipcMain.handle('settings:get', () => botService!.getSettings());
  ipcMain.handle('settings:update', (_e, settings) => botService!.updateSettings(settings));
  ipcMain.handle('status:get', () => botService!.getStatus());
  ipcMain.handle('followers:get', () => botService!.getFollowerList());
  ipcMain.handle('bot:start', () => botService!.start());
  ipcMain.handle('bot:stop', () => botService!.stop());
  ipcMain.handle('bot:scrape', () => botService!.startScraping());
  ipcMain.handle('bot:clear', () => botService!.clearSession());
  ipcMain.handle('logs:get', () => logger.getLogBuffer());

  // Forward log entries to renderer
  logger.setLogCallback((entry: LogEntry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log:entry', entry);
    }
  });

  // Forward status updates to renderer
  botService.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status:update', status);
    }
  });
};

app.whenReady().then(() => {
  botService = new BotService();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (botService) {
    event.preventDefault();
    await botService.stop();
    botService = null;
    app.exit(0);
  }
});
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Build complete.

**Step 3: Commit**

```bash
git add src/main/main.ts
git commit -m "feat: wire Electron main process with full IPC bridge to BotService"
```

---

## Phase 3: UI Implementation

### Task 8: Build the Linear-style design system CSS

**Files:**
- Modify: `src/renderer/styles/app.css`

**Step 1: Write the complete CSS design system**

This is the full Linear-inspired dark UI design system with FontAwesome integration. Clean, minimal, monochrome with blue accent.

The CSS should include:
- Design tokens (colors, spacing, radius, typography)
- Reset and base styles
- App shell layout (sidebar + main content)
- Sidebar with nav items using FA icons
- Panel/card system
- Stats grid
- Form elements (inputs, toggles)
- Button variants (primary, secondary, ghost, danger)
- Table/list styles for follower queue
- Log viewer (scrolling monospace terminal)
- Toast/notification system
- Loading states
- Animations (subtle fade/slide)
- Responsive adjustments

**Key colors:**
```css
--bg: #09090b;
--surface: #18181b;
--elevated: #27272a;
--border: #3f3f46;
--border-subtle: #27272a;
--text: #fafafa;
--text-secondary: #a1a1aa;
--text-muted: #71717a;
--accent: #3b82f6;
--accent-hover: #60a5fa;
--success: #22c55e;
--warning: #eab308;
--danger: #ef4444;
```

This file will be ~800 lines. Write the complete CSS following these design tokens and the Linear aesthetic. No gradients, no glow, no emojis. Clean borders, subtle hover states, tight spacing.

**Step 2: Commit**

```bash
git add src/renderer/styles/app.css
git commit -m "feat: implement Linear-style dark design system with FontAwesome"
```

---

### Task 9: Build the renderer app (UI logic)

**Files:**
- Modify: `src/renderer/app.ts`
- Modify: `src/renderer/index.html` (if needed)

**Step 1: Implement the full renderer with 4 views**

The renderer uses vanilla TypeScript with a simple component pattern (functions that return HTML strings, inserted via innerHTML). It communicates with the main process via `window.peanut` (the preload API).

**Views:**
1. Dashboard - Status overview, controls
2. Settings - Configuration form with rate limit warnings
3. Queue - Follower list and scheduled actions
4. Log - Live scrolling log output

**Architecture:**
- State managed via simple object + `render()` function
- IPC polling every 5 seconds for status updates
- Real-time log entries via IPC event listener
- FontAwesome icons throughout

The renderer should be ~600-800 lines of TypeScript. Include:
- Navigation with FA icons
- Dashboard with stat cards
- Settings form with all configurable options + inline warnings
- Queue view showing follower list with scraping progress
- Log view with auto-scroll and level filtering
- Toast notification system
- Loading states

**Step 2: Build and test visually**

Run: `npm run dev`
Expected: App launches with the new UI. All 4 views navigable. Forms render correctly.

**Step 3: Commit**

```bash
git add src/renderer/app.ts src/renderer/index.html
git commit -m "feat: implement full renderer UI with dashboard, settings, queue, and log views"
```

---

## Phase 4: Integration & Testing

### Task 10: Integration test - build and launch

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build, all files in dist/

**Step 2: Launch and verify**

Run: `npm run dev`
Expected: App launches, shows loading then dashboard. Settings form works. All views render.

**Step 3: Test login flow**

Manually test: Click start with a target configured. Verify Puppeteer launches and shows Instagram login page.

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: Peanut v2 complete - TypeScript rewrite with chunked scraping and Linear UI"
```

---

## Implementation Notes

### Browser Testing with Chrome DevTools MCP
Use the Chrome DevTools MCP to navigate Instagram and verify:
1. The followers dialog structure (what selectors work)
2. What API endpoints Instagram calls when loading followers
3. The follow/unfollow button selectors on profile pages

### Critical Safety Rules
- NEVER exceed 50 actions/day under any configuration
- ALWAYS add random jitter to delays
- ALWAYS check active hours before acting
- Log every action for debugging

### Files to Remove (old JS)
After v2 is working, remove:
- `src/index.js`
- `src/instagram.js`
- `src/botService.js`
- `src/config.js`
- `src/state.js`
- `src/scheduler.js`
- `src/utils/logger.js`
- `src/utils/sort.js`
- `src/utils/time.js`
- `src/electron/` (entire old directory)
- `src/scripts/`
