# Peanut

Peanut is a production-ready Node.js CLI that automates Instagram follow/unfollow routines with safe scheduling, resume support, and session persistence. It logs in once, saves cookies, and then runs a daily routine that follows up to 30 accounts (1–2 per hour) and unfollows them 24 hours later. The bot stops automatically when it reaches followers that follow fewer than 600 accounts, as requested.

> **Disclaimer**: Automating Instagram actions may violate Instagram’s Terms of Service. Use this tool responsibly and at your own risk.

## Features

- **Session persistence** using `cookies.json` so you don’t re-login every run.
- **Follower collection** with infinite scrolling and scraping.
- **Sorting by following count** to prioritize users who follow the most people.
- **Daily scheduling** (30 follows/day, spaced hourly).
- **Automatic unfollows** exactly 24 hours later.
- **State persistence** (`state.json`) to resume safely after interruptions.
- **Graceful stopping** when the following-count threshold is reached.
- **Dry-run mode** for safe testing and demos.

## Requirements

- Node.js 18+
- An Instagram account with access to the target’s follower list (private targets must already be followed).

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `INSTAGRAM_USERNAME` | Instagram username | — |
| `INSTAGRAM_PASSWORD` | Instagram password | — |
| `INSTAGRAM_TARGET` | Target username | — |
| `PEANUT_COOKIES_PATH` | Path to cookies file | `cookies.json` |
| `PEANUT_STATE_PATH` | Path to state file | `state.json` |
| `PEANUT_DAILY_FOLLOW_LIMIT` | Daily follow limit | `30` |
| `PEANUT_FOLLOW_INTERVAL_MINUTES` | Minutes between follows | `60` |
| `PEANUT_MIN_FOLLOWING_COUNT` | Minimum following threshold | `600` |
| `PEANUT_HEADLESS` | Headless mode | `true` |
| `PEANUT_SCHEDULER_INTERVAL_MINUTES` | Scheduler tick interval | `10` |
| `PEANUT_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |

## Usage

```bash
npm start -- --target someuser
```

### Options

```bash
npm start -- --target someuser --refresh
npm start -- --target someuser --dry-run
```

| Flag | Description |
| --- | --- |
| `--target` | Override `INSTAGRAM_TARGET` |
| `--refresh` | Rebuild the follower list and sorting |
| `--headless` | Override headless mode |
| `--dry-run` | Simulate actions without clicking buttons |

## How it Works

1. **Login & Cookies**: Peanut opens Instagram, uses saved cookies if present, otherwise logs in using the provided credentials.
2. **Follower Collection**: The bot opens the follower modal and scrolls until all followers are loaded, then collects usernames.
3. **Following Count**: For each follower, it reads the “Following” count from their profile.
4. **Sorting**: Followers are sorted descending by `followingCount`.
5. **Daily Follow Queue**: Each day, up to 30 follows are scheduled, spaced hourly.
6. **Unfollow Queue**: Every follow schedules an unfollow exactly 24 hours later.
7. **Stop Condition**: Once the next candidate has fewer than 600 followings, the scheduler stops.

## Testing

```bash
npm test
```

## Project Structure

```
src/
  index.js         # CLI entrypoint
  instagram.js     # Puppeteer automation
  scheduler.js     # Scheduling logic
  state.js         # State persistence
  utils/
    logger.js      # Structured logging
    sort.js        # Sorting helpers
    time.js        # Date utilities
```

## Troubleshooting

- **Private account**: Ensure your account follows the target so you can see their follower list.
- **Expired cookies**: Delete `cookies.json` to force a fresh login.
- **Checkpoint**: If Instagram presents a checkpoint, run with `PEANUT_HEADLESS=false` and complete it manually.

## License

MIT
