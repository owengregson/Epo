/**
 * READ-ONLY diagnosis (`EPO_PROBE=unfollow-hover`, `EPO_PROBE_TARGET=<an account
 * we follow>`): do the unfollow controls change under the cursor? For the
 * header action button and then the menu's confirm control: pin the node at
 * the located centre, rest the cursor there (production motion), sample the
 * located rect + pinned node every 100 ms. The header press only OPENS the
 * menu (the unfollow mutation fires on the confirm, which is never pressed);
 * the menu is closed by navigating away.
 */

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { SURFACE } from '@/adapter/ig-surface';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { sleep } from '@/timing/primitives';

type Rect = { x: number; y: number; width: number; height: number };
type Located = { found: boolean; rect?: Rect };

const PIN = (x: number, y: number): string =>
  `(function () { window.__probePin = document.elementFromPoint(${x}, ${y}); var p = window.__probePin; return p ? p.tagName + '|' + (p.getAttribute('role') || '') : null; })()`;
const PINNED = (x: number, y: number): string =>
  `(function () { var p = window.__probePin; var now = document.elementFromPoint(${x}, ${y}); return { connected: !!(p && p.isConnected), same: now === p, top: now ? now.tagName + '|' + (now.getAttribute('role') || '') : null }; })()`;

async function hoverTrace(tab: InstagramTab, script: () => string, ms: number): Promise<unknown> {
  const first = await tab.evaluate<Located>(script());
  if (!first?.found || first.rect === undefined) return { found: false, first };
  const at = { x: first.rect.x + first.rect.width / 2, y: first.rect.y + first.rect.height / 2 };
  const pinned = await tab.evaluate<unknown>(PIN(at.x, at.y));
  await createTabInteractor(tab).moveTo(at.x, at.y);
  const trace: unknown[] = [];
  let last = '';
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const loc = await tab.evaluate<Located>(script());
    const pin = await tab.evaluate<unknown>(PINNED(at.x, at.y));
    const key = JSON.stringify([loc.rect, pin]);
    if (key !== last) trace.push({ t: Date.now() - t0, rect: loc.rect ?? null, pin });
    last = key;
    await sleep(100);
  }
  return { first: first.rect, pinned, trace };
}

export async function unfollowHoverProbe(tab: InstagramTab, out: string): Promise<void> {
  const target = process.env.EPO_PROBE_TARGET?.trim() ?? '';
  if (target === '') throw new Error('EPO_PROBE_TARGET (an account we follow) is required');
  const result: Record<string, unknown> = { target };
  const shot = async (name: string): Promise<void> =>
    writeFileSync(path.join(out, name), await tab.captureScreenshot());
  try {
    await tab.goto(SURFACE.profileUrl(target));
    // The header button's geometry from the moment `goto` resolves —
    // production presses it as soon as it is first found during hydration.
    const hydrating: unknown[] = [];
    let lastHeader = '';
    const h0 = Date.now();
    while (Date.now() - h0 < 4000) {
      const loc = await tab.evaluate<Located>(SURFACE.locateActionButtonScript('unfollow'));
      const key = JSON.stringify(loc?.rect ?? null);
      if (key !== lastHeader) hydrating.push({ t: Date.now() - h0, found: loc?.found ?? false, rect: loc?.rect ?? null });
      lastHeader = key;
      await sleep(30);
    }
    result.headerHydrating = hydrating;
    await sleep(2000);
    result.state = await tab.evaluate<unknown>(SURFACE.probeStateScript());
    result.header = await hoverTrace(tab, () => SURFACE.locateActionButtonScript('unfollow'), 1500);
    await shot('header-hovered.png');
    // The production press of the header button: it only opens the menu.
    const button = await tab.evaluate<Located>(SURFACE.locateActionButtonScript('unfollow'));
    result.headerPress = button.rect === undefined
      ? { found: false }
      : await createTabInteractor(tab).click(button.rect).then(() => 'pressed', (e: unknown) => ({ threw: String(e) }));
    // The menu's geometry from the moment it exists — production locates the
    // confirm as soon as it is found (250 ms polls), not after a settle.
    const opening: unknown[] = [];
    let lastRect = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      const loc = await tab.evaluate<Located>(SURFACE.locateConfirmUnfollowScript());
      const key = JSON.stringify(loc.rect ?? null);
      if (key !== lastRect) opening.push({ t: Date.now() - t0, found: loc.found, rect: loc.rect ?? null });
      lastRect = key;
      await sleep(30);
    }
    result.menuOpening = opening;
    await shot('menu.png');
    result.confirm = await hoverTrace(tab, () => SURFACE.locateConfirmUnfollowScript(), 1500);
    await shot('confirm-hovered.png');
  } finally {
    await tab.goto(IG_HOME_URL).catch(() => undefined); // closes the menu; nothing confirmed
    writeFileSync(path.join(out, 'unfollow-hover.json'), JSON.stringify(result, null, 2), 'utf8');
  }
}
