/**
 * Live action smoke-test — Electron entry point.
 *
 * One command (`npm run livetest`) launches a visible Instagram window. The user
 * logs in ONCE; the harness then exercises EVERY real action the app
 * performs — acquire, enrich, score/plan, follow, follow-back check, unfollow,
 * sentinel — against live Instagram, conservatively paced and bounded, and
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

import { app } from 'electron';
import type { InstagramTab } from '@/adapter/tab';
import { LiveTestHarness } from '@/livetest/steps';
import {
  awaitLogin,
  bootstrapApp,
  ensureInstagramOrigin,
  openToolWindow,
} from '@/main/bootstrap';
import * as logger from '@/utils/logger';

// Identity + the background-survival switches — the livetest must exercise the
// identical renderer environment production does, including running while the
// window is backgrounded/occluded. It shares the production userData directory
// and login partition.
bootstrapApp();

let instagramTab: InstagramTab | null = null;
let harness: LiveTestHarness | null = null;
let finished = false;


async function run(): Promise<void> {
  const tool = openToolWindow({ title: 'Epo — Live Action Test' });
  const { win, tab } = tool;
  instagramTab = tab;

  const test = new LiveTestHarness(tab);
  harness = test;

  win.on('closed', () => {
    void finish();
  });

  await tool.ready;
  await test.setStatus(
    'Log in — the live action test begins once you are logged in.',
    'Nothing runs until a session cookie appears.',
  );

  if (!(await awaitLogin(tool.isOpen))) return; // window closed during login wait

  await test.setStatus('Logged in — starting live action test…');
  await ensureInstagramOrigin(tab);

  let summary: Awaited<ReturnType<typeof test.run>>;
  try {
    summary = await test.run();
  } catch (e) {
    // run() is designed never to throw, but surface any escape loudly.
    logger.error('livetest.run fatal', { error: String(e) });
    await test.setStatus('Live test errored — see terminal.', String(e));
    return;
  }

  const line = `${summary.verdict} · ${summary.actionsPerformed} action(s)`;
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
