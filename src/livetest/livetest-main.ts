/**
 * Live action smoke-test — Electron entry point.
 *
 * One command (`npm run livetest`) launches a visible Instagram window. The user
 * logs in ONCE; the harness then AUTOMATICALLY exercises EVERY real action the
 * bot performs — acquire, enrich, score/plan, follow, follow-back check, unfollow,
 * sentinel — against live Instagram, paced and bounded like a cautious human, and
 * prints a PASS/FAIL report to the terminal. It reuses the production adapter/rim/
 * store; nothing here reimplements them.
 *
 * Flow (mirrors the Task E capture app):
 *   1. Open a BaseWindow filled by the Instagram tab.
 *   2. Navigate to instagram.com; ask the user to log in.
 *   3. Poll the `persist:ig` `sessionid` cookie until login completes.
 *   4. Run the live test sequence (throwaway graph on a SEPARATE temp DB).
 *   5. Print the STEP|STATUS|DETAIL table + footprint + verdict; leave the window
 *      open so the user can read the on-tab banner.
 *   6. On window close: dispose (store close + metering unsub) and quit.
 */

import { app, BaseWindow, session } from 'electron';
import { InstagramTab, IG_PARTITION, IG_HOME_URL } from '@/adapter/tab';
import { LiveTestHarness } from '@/livetest/steps';
import * as logger from '@/utils/logger';

/** Poll interval while waiting for login. */
const LOGIN_POLL_MS = 2000;

let mainWindow: BaseWindow | null = null;
let instagramTab: InstagramTab | null = null;
let harness: LiveTestHarness | null = null;
let finished = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True once the persistent IG session holds a non-empty `sessionid` cookie. */
async function isLoggedIn(): Promise<boolean> {
  try {
    const cookies = await session.fromPartition(IG_PARTITION).cookies.get({ name: 'sessionid' });
    return cookies.some((c) => c.value && c.value.length > 0);
  } catch (e) {
    logger.warn('livetest.isLoggedIn cookie check failed', { error: String(e) });
    return false;
  }
}

async function run(): Promise<void> {
  const win = new BaseWindow({
    width: 1400,
    height: 900,
    title: 'Peanut — Live Action Test',
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

  const test = new LiveTestHarness(tab);
  harness = test;

  win.on('closed', () => {
    void finish();
  });

  await tab.goto(IG_HOME_URL);
  await test.setStatus(
    'Log in — the live action test runs automatically once you are logged in.',
    'Nothing runs until a session cookie appears.',
  );

  // Poll for login.
  while (mainWindow && !(await isLoggedIn())) {
    await delay(LOGIN_POLL_MS);
  }
  if (!mainWindow) return; // window closed during login wait

  await test.setStatus('Logged in — starting live action test…');

  // Ensure we're on an instagram.com origin so the page's own fetches are
  // same-origin (required by current_user + the direct JSON fetches).
  if (!tab.currentUrl().includes('instagram.com')) {
    await tab.goto(IG_HOME_URL);
    await delay(2000);
  }

  let summary;
  try {
    summary = await test.run();
  } catch (e) {
    // run() is designed never to throw, but surface any escape loudly.
    logger.error('livetest.run fatal', { error: String(e) });
    await test.setStatus('Live test errored — see terminal.', String(e));
    return;
  }

  const line = `${summary.verdict} · ${summary.actionsPerformed} action(s), ${summary.requestsSpent} request(s)`;
  await test.setStatus('Done — see terminal. Close the window when finished.', line);
}

/** Finalize on window close: dispose the harness, print nothing more, quit. Idempotent. */
async function finish(): Promise<void> {
  if (finished) return;
  finished = true;

  try {
    harness?.dispose();
  } catch (e) {
    logger.warn('livetest.dispose harness failed', { error: String(e) });
  }
  try {
    instagramTab?.dispose();
  } catch (e) {
    logger.warn('livetest.dispose tab failed', { error: String(e) });
  }
  harness = null;
  instagramTab = null;
  mainWindow = null;
  app.quit();
}

app.whenReady().then(() => {
  run().catch((e) => {
    logger.error('livetest.run fatal', { error: String(e) });
  });
});

app.on('window-all-closed', () => {
  // The live-test app is single-window; quitting on close is correct on all OSes.
  app.quit();
});
