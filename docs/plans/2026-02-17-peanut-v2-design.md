# Peanut v2 - Full Rewrite Design

## Goal

Rewrite Peanut from the ground up as a TypeScript Electron app for Instagram follow/unfollow growth automation with safe rate limiting, chunked follower scraping with resume, and a polished Linear-style UI.

## Architecture

### Tech Stack
- **Language:** TypeScript
- **Build:** esbuild (fast, zero-config TS compilation)
- **Runtime:** Electron (main + renderer processes)
- **Automation:** Puppeteer with stealth plugin
- **UI:** Vanilla TypeScript + FontAwesome 6 Free (no framework)
- **State:** JSON file persistence

### Directory Structure
```
src/
  main/                          # Electron main process
    main.ts                      # Electron shell, IPC handlers
    preload.ts                   # Context bridge

  renderer/                      # Electron renderer (UI)
    index.html
    app.ts                       # UI logic
    styles/
      app.css                    # Linear-style design system

  core/                          # Instagram automation engine
    instagram-client.ts          # Puppeteer browser + cookie auth
    scraper.ts                   # API response interceptor + chunked scraping
    actions.ts                   # Follow/unfollow with human delays
    rate-limiter.ts              # Token bucket rate limiter with jitter

  state/
    state.ts                     # App state persistence
    scrape-cursor.ts             # Chunked scraping resume cursor

  utils/
    logger.ts                    # Structured logging
    humanize.ts                  # Random delays, jitter, active hours
    time.ts                      # Date utilities

tsconfig.json
esbuild.config.mjs
```

## Automation Engine

### Login Flow (unchanged concept)
1. Launch Puppeteer with stealth plugin
2. Load saved cookies, navigate to instagram.com
3. If redirected to login -> open visible browser for manual login + 2FA
4. Save cookies on successful auth

### Follower Scraping (new - hybrid approach)
Strategy: Use Puppeteer for human-like navigation, intercept Instagram's GraphQL API responses for structured data.

1. Navigate to target profile page
2. Click "followers" link to open the followers dialog
3. Set up `page.on('response')` interceptor for `friendships/` endpoints
4. Scroll the dialog with human-like behavior (random distances, random pauses 1-3s)
5. Collect follower data from intercepted JSON responses
6. After collecting a chunk (default: 200 users), save cursor to disk
7. Resume from cursor on next session

### Scrape Cursor
```typescript
interface ScrapeCursor {
  targetUsername: string;
  totalCollected: number;
  lastUserId: string;
  collectedUsernames: string[];
  isComplete: boolean;
  lastScrapedAt: string;
}
```

### Follow/Unfollow Actions
- Navigate to user profile
- Locate and click Follow/Unfollow button via DOM
- Confirm unfollow in dialog
- All actions get human-like delays with jitter

## Rate Limiting

### Configuration (with safe defaults)
```typescript
interface RateLimiterConfig {
  maxActionsPerDay: number;        // Default: 20
  minDelayBetweenActions: number;  // Default: 180000ms (3 min)
  maxDelayBetweenActions: number;  // Default: 420000ms (7 min)
  activeHoursStart: number;        // Default: 8 (8am)
  activeHoursEnd: number;          // Default: 22 (10pm)
  jitterPercent: number;           // Default: 30 (+-30%)
}
```

### Safety Features
- All delays get random jitter: `delay * (1 + random(-jitter, +jitter))`
- Actions outside active hours are queued for next active window
- UI warnings at unsafe thresholds:
  - >30 follows/day: yellow warning
  - >50 follows/day: red "HIGH BAN RISK" warning
  - <60s between actions: red warning

## UI Design

### Design Philosophy: Linear-style Minimal Dark
- **Palette:** `#09090b` (bg), `#18181b` (surface), `#27272a` (elevated), `#3f3f46` (border)
- **Accent:** `#3b82f6` (blue)
- **Text:** `#fafafa` (primary), `#a1a1aa` (secondary), `#71717a` (muted)
- **No gradients, no glow effects, no emojis**
- System font stack (Inter / SF Pro / system)
- FontAwesome 6 Free for all icons

### Views
1. **Dashboard** - Status overview, progress, next actions, daily stats
2. **Settings** - All config in clean form, inline rate limit warnings
3. **Queue** - Follower list, scraping progress, scheduled actions
4. **Log** - Live scrolling automation log output

### Icons (FontAwesome 6)
- Nav: `fa-gauge-high`, `fa-gear`, `fa-users`, `fa-terminal`
- Status: `fa-circle-play`, `fa-circle-stop`, `fa-spinner`
- Stats: `fa-bullseye`, `fa-user-plus`, `fa-user-minus`, `fa-clock`
- Actions: `fa-play`, `fa-stop`, `fa-arrows-rotate`, `fa-trash-can`
- Warnings: `fa-triangle-exclamation`

## State Management

### App State
```typescript
interface AppState {
  target: string;
  scrapeCursor: ScrapeCursor | null;
  followerList: FollowerEntry[];
  nextFollowIndex: number;
  followQueue: ScheduledAction[];
  followHistory: HistoryEntry[];
  pendingUnfollows: ScheduledAction[];
  lastDailyPlan: string | null;
}
```

### Settings (persisted separately)
```typescript
interface Settings {
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
}
```
