/**
 * READ-ONLY notifications probe (`EPO_PROBE=notifications`): why the drawer
 * click is refused, then what the drawer fetches. Local DOM reads before and
 * after the cursor rests on the nav control (the production input path), a
 * screenshot of each, then ONE production `clickNotifications` with the
 * traffic recorder on — the drawer's own feed request is the evidence.
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
import { sleep } from '@/timing/primitives';

/** The located control, the nav's box, and the ancestor chain of the hit at its centre. */
const diagnose = (rect: { x: number; y: number; width: number; height: number }): string => `(function () {
  var cx = ${rect.x + rect.width / 2}, cy = ${rect.y + rect.height / 2};
  var box = function (el) { var r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  var chain = [];
  for (var el = document.elementFromPoint(cx, cy), i = 0; el && i < 10; el = el.parentElement, i++) {
    chain.push({ tag: el.tagName, role: el.getAttribute('role'), label: el.getAttribute('aria-label'), href: el.getAttribute('href'), box: box(el) });
  }
  var nav = document.querySelector('nav') || document.querySelector('[role="navigation"]');
  return { centre: [cx, cy], nav: nav ? box(nav) : null, viewport: [innerWidth, innerHeight], chain: chain };
})()`;

type Rect = { x: number; y: number; width: number; height: number };

export async function notificationsProbe(tab: InstagramTab, out: string): Promise<void> {
  const save = (name: string, value: unknown): void =>
    writeFileSync(path.join(out, name), JSON.stringify(value, null, 2), 'utf8');
  const shot = async (name: string): Promise<void> =>
    writeFileSync(path.join(out, name), await tab.captureScreenshot());
  const result: Record<string, unknown> = {};
  await tab.goto(IG_HOME_URL);
  await sleep(6000);

  const before = await tab.evaluate<{ found: boolean; rect?: Rect }>(SURFACE.locateNotificationsLinkScript());
  result.locateBefore = before;
  if (!before?.found || before.rect === undefined) return save('notifications.json', result);
  result.diagBefore = await tab.evaluate<unknown>(diagnose(before.rect));
  await shot('nav-before.png');

  // Rest the cursor on the control exactly as a click's travel would end.
  const interactor = createTabInteractor(tab);
  await interactor.moveTo(before.rect.x + before.rect.width / 2, before.rect.y + before.rect.height / 2);
  await sleep(1500);
  const hovered = await tab.evaluate<{ found: boolean; rect?: Rect }>(SURFACE.locateNotificationsLinkScript());
  result.locateHovered = hovered;
  result.diagHovered = await tab.evaluate<unknown>(diagnose(before.rect));
  await shot('nav-hovered.png');
  // Move off the rail so the real click starts from rest, like production.
  await interactor.moveTo(700, 450);
  await sleep(1500);

  const wc = webContents.getAllWebContents().find((c) => c.getURL().includes('instagram.com'));
  const rec = wc === undefined ? null : new TrafficRecorder(wc, out);
  rec?.setStep('notifications-click');
  rec?.start();
  try {
    const actor = new Actor(tab, { interactor: createTabInteractor(tab) });
    result.click = await actor.clickNotifications().catch((e: unknown) => ({ threw: String(e) }));
    await sleep(6000);
    await shot('drawer.png');
    result.drawerDom = await domCheck(tab, ['follows-filter', 'requests-entry', 'drawer-close', 'drawer-scroller']);
  } finally {
    await sleep(2000);
    rec?.stop();
    save('notifications-traffic.json', rec?.exchanges ?? []);
    save('notifications.json', result);
  }
}
