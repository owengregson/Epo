/**
 * DOM element inspection harness — Electron entry point.
 *
 * One command (`npm run inspect`) launches a visible Instagram window. The user
 * logs in ONCE; the harness then instruments the page so that clicking any
 * element CAPTURES its full details (tag, attributes, dataset, text, an ancestor
 * chain, outerHTML, and the URL) for the developer to derive robust, drift-proof
 * selectors for the versioned surface module (`src/adapter/versions/*`).
 *
 * Safe by default: every click is intercepted (preventDefault +
 * stop[Immediate]Propagation) so NOTHING happens — no navigation, no real
 * follow/unfollow. The user flips a floating bottom-right toggle to PASS-THROUGH
 * only when a real click is needed first (e.g. to open the unfollow menu).
 *
 * Flow (mirrors the Task E capture app):
 *   1. Open a BaseWindow filled by the Instagram tab.
 *   2. Navigate to instagram.com; ask the user to log in (plain banner, no
 *      interception — the login form must work).
 *   3. Poll the `persist:ig` `sessionid` cookie until login completes.
 *   4. Land on EPO_INSPECT_TARGET if set, else the resolved own profile,
 *      else stay on home.
 *   5. Run a ~300ms inspection loop: install-if-missing the instrumentation,
 *      then drain buffered click records — append each as one JSONL line and
 *      print a one-line summary with a suggested selector.
 *   6. On window close: print a final saved-count line, dispose, quit.
 */

import { app, BaseWindow, session } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { InstagramTab, IG_PARTITION, IG_HOME_URL } from '@/adapter/tab';
import { resolveOwnUsername } from '@/adapter/identity';
import * as logger from '@/utils/logger';
import { sleep } from '@/timing/primitives';
import { HARNESS } from '@/timing/config';
import {
  INSPECT_BANNER_TEXT,
  buildInspectTickScript,
  buildPreLoginBannerScript,
  type InspectRecord,
} from '@/inspect/injection';

/** Poll interval while waiting for login. */
const LOGIN_POLL_MS = HARNESS.LOGIN_POLL_MS;

/** Inspection poll interval — how often we drain buffered click records. */
const INSPECT_POLL_MS = HARNESS.INSPECT_POLL_MS;

let mainWindow: BaseWindow | null = null;
let instagramTab: InstagramTab | null = null;
let finished = false;
let recordCount = 0;
let outFile = '';

/** Output file for captured clicks (may contain real profile data → gitignored). */
function resolveOutFile(): string {
  const dir = path.join(process.cwd(), 'docs', 'adapter', 'inspect');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'clicks.jsonl');
}


/** True once the persistent IG session holds a non-empty `sessionid` cookie. */
async function isLoggedIn(): Promise<boolean> {
  try {
    const cookies = await session
      .fromPartition(IG_PARTITION)
      .cookies.get({ name: 'sessionid' });
    return cookies.some((c) => c.value && c.value.length > 0);
  } catch (e) {
    logger.warn('inspect.isLoggedIn cookie check failed', { error: String(e) });
    return false;
  }
}

/** Quote a value for an attribute selector, escaping any embedded double quote. */
function quoteAttr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Heuristically suggest a robust selector for a captured record. Prefers a
 * stable, semantically meaningful hook over IG's churny hashed class names.
 */
function suggestSelector(rec: InspectRecord): string {
  const tag = rec.tag || '*';

  // Links: the href is the most stable hook. Prefer a substring match for the
  // well-known profile sub-routes so the selector survives username changes.
  if (tag === 'a' && rec.href) {
    if (rec.href.includes('/followers/')) return 'a[href*="/followers/"]';
    if (rec.href.includes('/following/')) return 'a[href*="/following/"]';
    return `a[href=${quoteAttr(rec.href)}]`;
  }

  const isButtonish =
    tag === 'button' || rec.role === 'button' || rec.role === 'link';
  if (isButtonish) {
    if (rec.text) return `match by text: '${rec.text}'`;
    if (rec.ariaLabel) return `${tag}[aria-label=${quoteAttr(rec.ariaLabel)}]`;
  }

  // Otherwise pick the tightest stable attribute we can find.
  const stableAttrs = [
    'data-testid',
    'name',
    'aria-label',
    'role',
    'type',
    'alt',
    'title',
  ];
  for (const attr of stableAttrs) {
    const val = rec.attributes[attr];
    if (val) return `${tag}[${attr}=${quoteAttr(val)}]`;
  }
  if (rec.id) return `${tag}#${rec.id}`;
  if (rec.text) return `${tag} matching text: '${rec.text}'`;
  return tag;
}

/** Persist a drained record and print a one-line summary with a suggestion. */
function reportRecord(rec: InspectRecord): void {
  recordCount++;
  try {
    appendFileSync(outFile, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch (e) {
    logger.error('inspect.appendRecord failed', {
      error: String(e),
      outFile,
    });
  }

  if (rec.error) {
    console.log(`#${recordCount} <capture error> ${rec.error}`);
    return;
  }

  const text = rec.text ? `"${rec.text}"` : '""';
  const href = rec.href || '-';
  const role = rec.role || '-';
  const aria = rec.ariaLabel || '-';
  const selector = suggestSelector(rec);
  console.log(
    `#${recordCount} <${rec.tag}> text=${text} href=${href} role=${role} aria=${aria} → suggested: ${selector}`,
  );
}

/**
 * Decide the landing page after login: explicit target, else own profile, else
 * home. Returns a readable description of where we landed.
 */
async function landAfterLogin(tab: InstagramTab): Promise<string> {
  const target = process.env.EPO_INSPECT_TARGET?.trim();
  if (target) {
    const url = `https://www.instagram.com/${target}/`;
    await tab.goto(url);
    await sleep(3000);
    return `@${target}`;
  }

  const own = await resolveOwnUsername(tab);
  if (own) {
    await tab.goto(`https://www.instagram.com/${own}/`);
    await sleep(3000);
    return `@${own} (your profile)`;
  }

  logger.warn(
    'inspect: no EPO_INSPECT_TARGET and own username not resolved; staying on home',
  );
  if (!tab.currentUrl().includes('instagram.com')) {
    await tab.goto(IG_HOME_URL);
    await sleep(2000);
  }
  return 'home';
}

async function run(): Promise<void> {
  outFile = resolveOutFile();

  const win = new BaseWindow({
    width: 1400,
    height: 900,
    title: 'Epo — DOM Inspect',
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

  win.on('closed', () => {
    void finish();
  });

  await tab.goto(IG_HOME_URL);
  // Pre-login banner only — NO click interception yet, so the login form works.
  try {
    await tab.evaluate<boolean>(
      buildPreLoginBannerScript(
        'Please log in to Instagram. Element inspection begins once you are logged in.',
      ),
    );
  } catch (e) {
    logger.warn('inspect.preLoginBanner failed', { error: String(e) });
  }

  // Poll for login.
  while (mainWindow && !(await isLoggedIn())) {
    await sleep(LOGIN_POLL_MS);
  }
  if (!mainWindow) return; // window closed during login wait

  // Ensure an instagram.com origin (identity resolution + our injected fetches).
  if (!tab.currentUrl().includes('instagram.com')) {
    await tab.goto(IG_HOME_URL);
    await sleep(2000);
  }

  const landed = await landAfterLogin(tab);
  logger.info('inspect: logged in — inspection loop starting', {
    landed,
    outFile,
  });
  console.log(
    `\n=== Epo DOM inspect ===\nLanded on: ${landed}\nClick elements in the window (RECORD-ONLY is safe). Saving to: ${outFile}\n`,
  );

  const tickScript = buildInspectTickScript(INSPECT_BANNER_TEXT);

  // Inspection poll loop: install-if-missing, then drain buffered records.
  while (mainWindow) {
    try {
      const recs = await tab.evaluate<InspectRecord[]>(tickScript);
      if (Array.isArray(recs)) {
        for (const rec of recs) reportRecord(rec);
      }
    } catch (e) {
      // A navigation in flight can transiently reject evaluate — log and retry.
      logger.warn('inspect.tick evaluate failed', { error: String(e) });
    }
    await sleep(INSPECT_POLL_MS);
  }
}

/** Finalize on window close: print the saved count, dispose, quit. Idempotent. */
async function finish(): Promise<void> {
  if (finished) return;
  finished = true;

  console.log(
    `\nInspection saved to ${outFile} (${recordCount} records)\n`,
  );
  logger.info('inspect: SUMMARY', { records: recordCount, outFile });

  try {
    instagramTab?.dispose();
  } catch (e) {
    logger.warn('inspect.dispose tab failed', { error: String(e) });
  }
  instagramTab = null;
  mainWindow = null;
  app.quit();
}

app.whenReady().then(() => {
  run().catch((e) => {
    logger.error('inspect.run fatal', { error: String(e) });
  });
});

app.on('window-all-closed', () => {
  // The inspect app is single-window; quitting on close is correct on all OSes.
  app.quit();
});
