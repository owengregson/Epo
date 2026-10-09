/**
 * READ-ONLY evidence for the profile-visit and settle-then-press fixes
 * (`EPO_PROBE=visit`). Three questions:
 *
 *  1. How long after the cursor arrives does the hover-expanding nav rail stop
 *     re-rendering? (100 ms samples of the notifications control's rect and
 *     node identity — local reads.)
 *  2. Does the drawer's close control behave the same way under hover, and
 *     does settle-then-press close the drawer?
 *  3. What does a NONEXISTENT username's profile page answer — document
 *     status, which API traffic, what text — so a visit can call it `gone`
 *     honestly. One page load, like a mistyped URL.
 */

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { webContents } from 'electron';
import { SURFACE } from '@/adapter/ig-surface';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { TrafficRecorder } from '@/probe/recorder';
import { sleep } from '@/timing/primitives';

type Rect = { x: number; y: number; width: number; height: number };
type Located = { found: boolean; rect?: Rect };

/** Pin the node at `(x, y)` (probe-only page global) and compare later samples to it. */
const PIN = (x: number, y: number): string =>
  `(function () { window.__probePin = document.elementFromPoint(${x}, ${y}); return !!window.__probePin; })()`;
const PINNED = (x: number, y: number): string =>
  `(function () { var p = window.__probePin; var now = document.elementFromPoint(${x}, ${y}); return { connected: !!(p && p.isConnected), same: now === p }; })()`;

/** Sample `locate` + the pinned node every 100 ms for `ms`. */
async function settleTrace(tab: InstagramTab, locate: () => string, at: { x: number; y: number }, ms: number): Promise<unknown[]> {
  const trace: unknown[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const loc = await tab.evaluate<Located>(locate());
    const pin = await tab.evaluate<unknown>(PINNED(at.x, at.y));
    trace.push({ t: Date.now() - t0, rect: loc.rect ?? null, pin });
    await sleep(100);
  }
  return trace;
}

const centre = (r: Rect): { x: number; y: number } => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

async function hoverSettlePress(tab: InstagramTab, locate: () => string, dwellMs: number): Promise<unknown> {
  const interactor = createTabInteractor(tab);
  const first = await tab.evaluate<Located>(locate());
  if (!first.found || first.rect === undefined) return { found: false };
  const c = centre(first.rect);
  await interactor.moveTo(c.x, c.y);
  await sleep(dwellMs);
  const settled = await tab.evaluate<Located>(locate());
  if (!settled.found || settled.rect === undefined) return { found: false, afterHover: true };
  return interactor.click(settled.rect).then(
    () => ({ pressed: settled.rect }),
    (e: unknown) => ({ threw: String(e) }),
  );
}

export async function visitProbe(tab: InstagramTab, out: string): Promise<void> {
  const save = (name: string, value: unknown): void =>
    writeFileSync(path.join(out, name), JSON.stringify(value, null, 2), 'utf8');
  const result: Record<string, unknown> = {};
  const interactor = createTabInteractor(tab);
  try {
    // (1) The rail.
    await tab.goto(IG_HOME_URL);
    await sleep(6000);
    const bell = await tab.evaluate<Located>(SURFACE.locateNotificationsLinkScript());
    if (bell.rect === undefined) throw new Error('notifications control not found');
    const at = centre(bell.rect);
    await tab.evaluate(PIN(at.x, at.y));
    await interactor.moveTo(at.x, at.y);
    result.railTrace = await settleTrace(tab, () => SURFACE.locateNotificationsLinkScript(), at, 2500);
    await interactor.moveTo(700, 450);
    await sleep(1500);

    // (2) Open with settle-then-press, then trace and close the drawer the same way.
    result.open = await hoverSettlePress(tab, () => SURFACE.locateNotificationsLinkScript(), 1000);
    await sleep(5000);
    const x = await tab.evaluate<Located>(SURFACE.locateNotificationsCloseScript());
    result.closeLocated = x;
    if (x.rect !== undefined) {
      const xc = centre(x.rect);
      await tab.evaluate(PIN(xc.x, xc.y));
      await interactor.moveTo(xc.x, xc.y);
      result.closeTrace = await settleTrace(tab, () => SURFACE.locateNotificationsCloseScript(), xc, 1500);
      await interactor.moveTo(700, 450);
      await sleep(800);
      result.close = await hoverSettlePress(tab, () => SURFACE.locateNotificationsCloseScript(), 1000);
      await sleep(2500);
      result.closedAfter = await tab.evaluate<Located>(SURFACE.locateNotificationsCloseScript());
    }

    // (3) A username that does not exist.
    const wc = webContents.getAllWebContents().find((c) => c.getURL().includes('instagram.com'));
    const docs: unknown[] = [];
    const onDoc = (_e: unknown, method: string, p: Record<string, unknown>): void => {
      if (method !== 'Network.responseReceived' || p.type !== 'Document') return;
      const r = p.response as { url: string; status: number };
      docs.push({ url: r.url, status: r.status });
    };
    wc?.debugger.on('message', onDoc);
    const rec = wc === undefined ? null : new TrafficRecorder(wc, out);
    rec?.setStep('nonexistent');
    rec?.start();
    const nx = `epo_nx_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 8)}`;
    result.nonexistentUsername = nx;
    await tab.goto(SURFACE.profileUrl(nx)).catch((e: unknown) => {
      result.gotoThrew = String(e);
    });
    await sleep(7000);
    rec?.stop();
    wc?.debugger.off('message', onDoc);
    result.documents = docs;
    result.finalUrl = tab.currentUrl();
    result.page = await tab.evaluate<unknown>(`({
      title: document.title,
      headings: Array.from(document.querySelectorAll('h1, h2, span')).map(function (e) { return (e.textContent || '').trim(); })
        .filter(function (t) { return t.length > 0 && t.length < 120 && /available|exist|found|sorry|broken/i.test(t); }).slice(0, 8),
    })`);
    result.traffic = (rec?.exchanges ?? []).map((ex) => ({
      method: ex.method,
      path: ex.path,
      op: ex.form?.fb_api_req_friendly_name ?? ex.headers['x-fb-friendly-name'] ?? null,
      status: ex.status,
      epoKind: ex.epoKind,
      shape: ex.epoKind === null ? undefined : ex.shape,
    }));
    writeFileSync(path.join(out, 'nonexistent.png'), await tab.captureScreenshot());
  } finally {
    save('visit.json', result);
  }
}
