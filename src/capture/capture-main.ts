/**
 * Task E capture app — Electron entry point.
 *
 * One command (`npm run capture`) launches a visible Instagram window. The user
 * logs in ONCE; the harness then captures the real Instagram API
 * response shapes, DOM structures, and signatures that Tasks 7-8 will be built
 * and tested against. It reuses `InstagramTab` (CDP-based network observation)
 * and depends on nothing not-yet-built.
 *
 * Flow:
 *   1. Open a BaseWindow filled by the Instagram tab.
 *   2. Navigate to instagram.com; ask the user to log in.
 *   3. Poll the `persist:ig` session cookie until `sessionid` is present.
 *   4. Resolve the capture target: EPO_CAPTURE_TARGET, else the logged-in
 *      user's own username (via accounts/current_user).
 *   5. Run the harness capture flow; keep passive capture running.
 *   6. On window close: write manifest + draft notes, print a summary, quit.
 */

import { app, BaseWindow, session } from 'electron';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { InstagramTab, IG_PARTITION, IG_HOME_URL } from '@/adapter/tab';
import { resolveOwnUsername } from '@/adapter/identity';
import { CaptureHarness } from '@/capture/capture-harness';
import * as logger from '@/utils/logger';
import { sleep } from '@/timing/primitives';
import { HARNESS } from '@/timing/config';

/** Poll interval while waiting for login. */
const LOGIN_POLL_MS = HARNESS.LOGIN_POLL_MS;

let mainWindow: BaseWindow | null = null;
let instagramTab: InstagramTab | null = null;
let harness: CaptureHarness | null = null;
let finished = false;

/** Output root for all captured fixtures + inventory. */
function resolveOutDir(): string {
  const dir = path.join(process.cwd(), 'docs', 'adapter', 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}


/** True once the persistent IG session holds a non-empty `sessionid` cookie. */
async function isLoggedIn(): Promise<boolean> {
  try {
    const cookies = await session
      .fromPartition(IG_PARTITION)
      .cookies.get({ name: 'sessionid' });
    return cookies.some((c) => c.value && c.value.length > 0);
  } catch (e) {
    logger.warn('capture.isLoggedIn cookie check failed', { error: String(e) });
    return false;
  }
}

/** Detect the logged-in user's own username (robust — see `@/adapter/identity`). */
async function detectOwnUsername(tab: InstagramTab): Promise<string | null> {
  return (await resolveOwnUsername(tab)) ?? null;
}

/**
 * Read a few sample usernames from the newest saved `*followers-list.json`
 * fixture on disk (best-effort). Used as the middle-priority source of sample
 * accounts for profile-shape capture when no env override is set.
 */
function readSampleUsernamesFromFixtures(limit: number): string[] {
  try {
    const rawDir = path.join(resolveOutDir(), 'raw');
    const files = readdirSync(rawDir).filter((f) =>
      f.endsWith('followers-list.json'),
    );
    if (files.length === 0) return [];
    files.sort(
      (a, b) =>
        statSync(path.join(rawDir, b)).mtimeMs -
        statSync(path.join(rawDir, a)).mtimeMs,
    );
    const newest = path.join(rawDir, files[0]);
    const parsed = JSON.parse(readFileSync(newest, 'utf8')) as {
      users?: Array<{ username?: string }>;
    };
    const names: string[] = [];
    for (const u of parsed.users ?? []) {
      if (u.username && !names.includes(u.username)) names.push(u.username);
      if (names.length >= limit) break;
    }
    return names;
  } catch (e) {
    logger.warn('capture: reading sample usernames from fixtures failed', {
      error: String(e),
    });
    return [];
  }
}

/**
 * Resolve the sample accounts for profile-shape capture, in priority order:
 *   (a) EPO_CAPTURE_SAMPLES env (comma-separated);
 *   (b) 2-3 usernames from the newest saved followers-list fixture;
 *   (c) fallback `['instagram']`.
 * At least one NON-own public account is always included (so a real
 * Follow/Following button is captured); the detected own username is appended
 * too (its own-layout header is still useful).
 */
function resolveSamples(ownUsername: string): string[] {
  const samples: string[] = [];
  const push = (name: string): void => {
    const n = name.trim();
    if (n && !samples.includes(n)) samples.push(n);
  };

  const env = process.env.EPO_CAPTURE_SAMPLES?.trim();
  if (env) {
    for (const part of env.split(',')) push(part);
  } else {
    const fromFixtures = readSampleUsernamesFromFixtures(3);
    if (fromFixtures.length > 0) for (const u of fromFixtures) push(u);
    else push('instagram');
  }

  // Guarantee at least one non-own public account for the Follow button.
  if (!samples.some((s) => s !== ownUsername)) push('instagram');

  // Include the own username too (own-layout header is still useful).
  if (ownUsername) push(ownUsername);

  return samples;
}

async function run(): Promise<void> {
  const outDir = resolveOutDir();

  const win = new BaseWindow({
    width: 1400,
    height: 900,
    title: 'Epo — Task E Capture',
    backgroundColor: '#0e0e10',
  });
  mainWindow = win;

  const tab = new InstagramTab();
  instagramTab = tab;
  tab.attach(win);
  tab.show();

  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    tab.setBounds({ x: 0, y: 0, width, height });
  };
  win.on('resize', layout);
  layout();

  const cap = new CaptureHarness(tab, outDir);
  harness = cap;
  cap.start();

  win.on('closed', () => {
    void finish();
  });

  await tab.goto(IG_HOME_URL);
  await cap.setStatus(
    'Please log in to Instagram in this window…',
    'Capture begins once you are logged in.',
  );

  // Poll for login.
  while (mainWindow && !(await isLoggedIn())) {
    await sleep(LOGIN_POLL_MS);
  }
  if (!mainWindow) return; // window closed during login wait

  await cap.setStatus('Logged in — preparing capture…');

  // Ensure we're on an instagram.com origin so the page's own fetches are
  // same-origin (required by detectOwnUsername + the direct shape fetches).
  if (!tab.currentUrl().includes('instagram.com')) {
    await tab.goto(IG_HOME_URL);
    await sleep(2000);
  }

  // Detect the own username best-effort. This drives own-followers capture, but
  // its absence must NEVER dead-end the run — profile-shape capture always runs.
  let ownUsername = process.env.EPO_CAPTURE_TARGET?.trim() || '';
  if (!ownUsername) {
    const own = await detectOwnUsername(tab);
    if (own) {
      ownUsername = own;
      logger.info('capture.resolved own username', { ownUsername });
    } else {
      logger.warn(
        'capture: own username not detected (accounts/current_user unavailable); profile-shape capture will still run',
      );
    }
  }

  // Resolve the sample accounts for deterministic profile-shape capture.
  const samples = resolveSamples(ownUsername);
  logger.info('capture.resolved sample accounts', { samples, ownUsername });

  // (1) Own-followers capture — only if the own username is known. Best-effort.
  if (ownUsername) {
    await cap.setStatus('Capturing your followers…', `@${ownUsername}`);
    try {
      await cap.driveCaptureFlow(ownUsername);
    } catch (e) {
      logger.error('capture.driveCaptureFlow failed', { error: String(e) });
      await cap.setStatus(
        'Own-followers flow hit an error — continuing to profile capture.',
      );
    }
  }

  // (2) Profile-shape capture — ALWAYS runs. Best-effort.
  await cap.setStatus('Capturing profile shapes…', samples.join(', '));
  try {
    await cap.captureProfileShapes(samples);
  } catch (e) {
    logger.error('capture.captureProfileShapes failed', { error: String(e) });
  }

  await cap.setStatus(
    'Core + profile capture done — you may close the window.',
    'Optional: open the unfollow-confirm dialog or activity feed to capture more.',
  );
}

/** Finalize on window close: write outputs, print summary, quit. Idempotent. */
async function finish(): Promise<void> {
  if (finished) return;
  finished = true;

  const outDir = resolveOutDir();
  if (harness) {
    harness.stop();
    harness.writeManifest();
    harness.writeDraftNotes();
    const counts = harness.getCounts();
    logger.info('capture: SUMMARY', { counts, outDir });
    // Readable summary to stdout (console.log always prints).
    console.log('\n=== Epo capture summary ===');
    console.log(`output: ${outDir}`);
    const classNames = Object.keys(counts).sort();
    if (classNames.length === 0) {
      console.log('observed responses: none');
    } else {
      for (const c of classNames) console.log(`  ${c}: ${counts[c]}`);
    }
    console.log(`draft notes: ${path.join(outDir, '..', 'field-notes-DRAFT.md')}`);
    console.log('================================\n');
  }

  try {
    instagramTab?.dispose();
  } catch (e) {
    logger.warn('capture.dispose tab failed', { error: String(e) });
  }
  instagramTab = null;
  mainWindow = null;
  harness = null;
  app.quit();
}

app.whenReady().then(() => {
  run().catch((e) => {
    logger.error('capture.run fatal', { error: String(e) });
  });
});

app.on('window-all-closed', () => {
  // The capture app is single-window; quitting on close is correct on all OSes.
  app.quit();
});
