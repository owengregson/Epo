/**
 * READ-ONLY drawer probe (`EPO_PROBE=drawer`). Two questions, one home load:
 *
 *  1. The nav rail's structure — is the rail still a `nav` / `role=navigation`
 *     (the identity resolver's scope), and which profile anchors could answer
 *     for "our own profile link"? Local DOM reads only.
 *  2. Does hovering the rail REPLACE its nodes (which the click guard rightly
 *     refuses to press through)? Then: hover, let the rail settle, locate the
 *     control again and press it — does the drawer open, and what does it fetch?
 *     The Follows filter and the Follow-requests entry are opened if present
 *     (no request is ever confirmed), then the drawer is closed.
 */

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { webContents } from 'electron';
import { Actor } from '@/adapter/actor';
import { SURFACE } from '@/adapter/ig-surface';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { TrafficRecorder } from '@/probe/recorder';
import { domCheck } from '@/probe/traffic';
import { NAV_PROFILE_PATH_RE, ROLES, SELECTORS } from '@/surface/versions/2026-08-12/literals';
import { sleep } from '@/timing/primitives';

type Rect = { x: number; y: number; width: number; height: number };

const RAIL = `(function () {
  var rx = new RegExp(${JSON.stringify(SELECTORS.notificationsLabelText.source)}, ${JSON.stringify(SELECTORS.notificationsLabelText.flags)});
  var box = function (el) { var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  var icon = Array.from(document.querySelectorAll(${JSON.stringify(ROLES.labeled)})).find(function (el) { return rx.test(el.getAttribute('aria-label') || ''); });
  var ancestors = [];
  for (var el = icon; el && el !== document.body; el = el.parentElement) {
    var role = el.getAttribute('role');
    if (el.tagName === 'NAV' || role || el.tagName === 'A' || el.tagName === 'ASIDE' || el.tagName === 'HEADER') ancestors.push({ tag: el.tagName, role: role, box: box(el) });
  }
  var profRx = new RegExp(${JSON.stringify(NAV_PROFILE_PATH_RE.source)});
  var anchors = Array.from(document.querySelectorAll('a')).filter(function (a) { return profRx.test(a.getAttribute('href') || '') && a.querySelector('img'); })
    .slice(0, 8).map(function (a) { var img = a.querySelector('img'); return { href: a.getAttribute('href'), alt: img.getAttribute('alt'), box: box(a), imgBox: box(img), inNav: !!a.closest('nav, [role="navigation"]') }; });
  return {
    navs: Array.from(document.querySelectorAll('nav, [role="navigation"]')).map(function (n) { return { tag: n.tagName, role: n.getAttribute('role'), box: box(n), hasIcon: !!(icon && n.contains(icon)) }; }),
    icon: icon ? { tag: icon.tagName, box: box(icon) } : null,
    iconAncestors: ancestors,
    profileAnchors: anchors,
  };
})()`;

export async function drawerProbe(tab: InstagramTab, out: string): Promise<void> {
  const save = (name: string, value: unknown): void =>
    writeFileSync(path.join(out, name), JSON.stringify(value, null, 2), 'utf8');
  const result: Record<string, unknown> = {};
  await tab.goto(IG_HOME_URL);
  await sleep(6000);
  const rail = await tab.evaluate<{ icon: { box: Rect } | null }>(RAIL);
  result.rail = rail;
  if (rail.icon === null) return save('drawer.json', result);

  const wc = webContents.getAllWebContents().find((c) => c.getURL().includes('instagram.com'));
  const rec = wc === undefined ? null : new TrafficRecorder(wc, out);
  const interactor = createTabInteractor(tab);
  const actor = new Actor(tab, { interactor });
  const step = async (name: string, fn: () => Promise<unknown>, checks: string[] = []): Promise<void> => {
    rec?.setStep(name);
    result[name] = await fn().then(
      (v) => v ?? 'done',
      (e: unknown) => ({ threw: String(e) }),
    );
    await sleep(5000 + Math.random() * 2000);
    if (checks.length > 0) result[`${name}:dom`] = await domCheck(tab, checks);
    writeFileSync(path.join(out, `${name}.png`), await tab.captureScreenshot());
  };
  // Pin the icon and its link (probe-only page global), hover, then ask whether they survived.
  const stash = `(function () { var rx = new RegExp(${JSON.stringify(SELECTORS.notificationsLabelText.source)}, ${JSON.stringify(SELECTORS.notificationsLabelText.flags)});
    var icon = Array.from(document.querySelectorAll(${JSON.stringify(ROLES.labeled)})).find(function (el) { return rx.test(el.getAttribute('aria-label') || ''); });
    window.__probePinned = { icon: icon, link: icon && icon.closest('a') }; return !!icon; })()`;
  const survived = `(function () { var p = window.__probePinned || {}; var rx = new RegExp(${JSON.stringify(SELECTORS.notificationsLabelText.source)}, ${JSON.stringify(SELECTORS.notificationsLabelText.flags)});
    var now = Array.from(document.querySelectorAll(${JSON.stringify(ROLES.labeled)})).find(function (el) { return rx.test(el.getAttribute('aria-label') || ''); });
    return { iconConnected: !!(p.icon && p.icon.isConnected), linkConnected: !!(p.link && p.link.isConnected), sameIcon: now === p.icon, sameLink: !!now && now.closest('a') === p.link }; })()`;
  result.pinned = await tab.evaluate<boolean>(stash);
  const before = await tab.evaluate<{ found: boolean; rect?: Rect }>(SURFACE.locateNotificationsLinkScript());
  const r = before.rect as Rect;
  await interactor.moveTo(r.x + r.width / 2, r.y + r.height / 2);
  await sleep(1200);
  result.afterHover = await tab.evaluate<unknown>(survived);
  const settled = await tab.evaluate<{ found: boolean; rect?: Rect }>(SURFACE.locateNotificationsLinkScript());
  result.settledRect = settled;
  rec?.start();
  try {
    await step('icon-click', () => interactor.click(settled.rect as Rect), [
      'follows-filter', 'requests-entry', 'drawer-close', 'drawer-scroller',
    ]);
    await step('follows-filter', () => actor.clickNotificationsFollowsFilter());
    await step('requests-entry', () => actor.clickFollowRequestsEntry(), ['drawer-close']);
    await step('close', () => actor.clickNotificationsClose(), ['dialog-present']);
  } finally {
    await sleep(2000);
    rec?.stop();
    save('drawer-traffic.json', rec?.exchanges ?? []);
    save('drawer.json', result);
  }
}
