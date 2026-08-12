/**
 * Task E capture app — Electron entry point.
 *
 * One command (`npm run capture`) launches a visible Instagram window. The user
 * logs in ONCE; the harness then AUTOMATICALLY captures the real Instagram API
 * response shapes, DOM structures, and signatures that Tasks 7-8 will be built
 * and tested against. It reuses `InstagramTab` (CDP-based network observation)
 * and depends on nothing not-yet-built.
 *
 * Flow:
 *   1. Open a BaseWindow filled by the Instagram tab.
 *   2. Navigate to instagram.com; ask the user to log in.
 *   3. Poll the `persist:ig` session cookie until `sessionid` is present.
 *   4. Resolve the capture target: PEANUT_CAPTURE_TARGET, else the logged-in
 *      user's own username (via accounts/current_user).
 *   5. Run the harness capture flow; keep passive capture running.
 *   6. On window close: write manifest + draft notes, print a summary, quit.
 */

import { app, BaseWindow, session } from 'electron';
import { mkdirSync } from 'fs';
import * as path from 'path';
import { InstagramTab, IG_PARTITION, IG_HOME_URL } from '@/adapter/tab';
import { CaptureHarness } from '@/capture/capture-harness';
import * as logger from '@/utils/logger';

/** Instagram web app id — required header for the private JSON API. */
const IG_APP_ID = '936619743392459';

/** Poll interval while waiting for login. */
const LOGIN_POLL_MS = 2000;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Detect the logged-in user's own username via the private JSON API. */
async function detectOwnUsername(tab: InstagramTab): Promise<string | null> {
  try {
    const username = await tab.evaluate<string | null>(
      `fetch('/api/v1/accounts/current_user/', { headers: { 'x-ig-app-id': '${IG_APP_ID}' }, credentials: 'include' })
        .then(function(r){ return r.json(); })
        .then(function(j){ return (j && j.user && j.user.username) ? j.user.username : null; })
        .catch(function(){ return null; })`,
    );
    return username ?? null;
  } catch (e) {
    logger.warn('capture.detectOwnUsername failed', { error: String(e) });
    return null;
  }
}

async function run(): Promise<void> {
  const outDir = resolveOutDir();

  const win = new BaseWindow({
    width: 1400,
    height: 900,
    title: 'Peanut — Task E Capture',
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
    'Capture begins automatically once you are logged in.',
  );

  // Poll for login.
  while (mainWindow && !(await isLoggedIn())) {
    await delay(LOGIN_POLL_MS);
  }
  if (!mainWindow) return; // window closed during login wait

  await cap.setStatus('Logged in — resolving target…');

  // Resolve target: explicit env override, else the user's own account.
  let target = process.env.PEANUT_CAPTURE_TARGET?.trim() || '';
  if (!target) {
    // Ensure we're on an instagram.com origin so the fetch is same-origin.
    if (!tab.currentUrl().includes('instagram.com')) {
      await tab.goto(IG_HOME_URL);
      await delay(2000);
    }
    const own = await detectOwnUsername(tab);
    if (own) {
      target = own;
      logger.info('capture.resolved own username as target', { target });
    }
  }

  if (!target) {
    await cap.setStatus(
      'Could not detect your username.',
      'Close this window and re-run with PEANUT_CAPTURE_TARGET=<username>.',
    );
    logger.error(
      'capture: no target resolved; re-run with PEANUT_CAPTURE_TARGET=<username>',
    );
    return; // keep the window open so the user can read the banner
  }

  try {
    await cap.driveCaptureFlow(target);
  } catch (e) {
    logger.error('capture.driveCaptureFlow failed', { error: String(e) });
    await cap.setStatus(
      'Automated flow hit an error — passive capture continues.',
      'Click the followers count / open dialogs manually. Close the window when done.',
    );
  }
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
    // Human-friendly summary to stdout (console.log always prints).
    console.log('\n=== Peanut capture summary ===');
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
