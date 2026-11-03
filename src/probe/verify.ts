/**
 * READ-ONLY end-to-end check of the 2026-10-08 fixes, through PRODUCTION code
 * only (`EPO_PROBE=verify`, `EPO_PROBE_TARGET=<a public account we follow>`):
 *
 *  1. profile VISITS (`TabProfileVisitor` + `ProfileObserver`): our own
 *     profile, the target, and a username that does not exist → ok / ok / gone;
 *  2. the notifications drawer through the production Actor (settle-then-press):
 *     open, Follows filter, Follow-requests panel (NOTHING is confirmed), close —
 *     with the activity-feed and pending-requests bodies parsed by the Reader;
 *  3. the rail's own-profile link (settle-then-press) lands on our profile.
 *
 * The observer writes to a no-op store: the probe never touches the real graph.
 */

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { webContents } from 'electron';
import { Actor } from '@/adapter/actor';
import { resolveOwnUsername } from '@/adapter/identity';
import { SURFACE } from '@/adapter/ig-surface';
import { Reader } from '@/adapter/reader';
import { Sentinel } from '@/adapter/sentinel';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { SystemClock } from '@/governors/clock';
import { TrafficRecorder } from '@/probe/recorder';
import { ProfileObserver } from '@/rim/profile-observer';
import { TabProfileVisitor } from '@/rim/profile-visit';
import { sleep } from '@/timing/primitives';
import { cryptoUniform } from '@/utils/entropy';
import * as logger from '@/utils/logger';

const settle = (): Promise<void> => sleep(5000 + cryptoUniform() * 3000);

export async function verifyProbe(tab: InstagramTab, out: string): Promise<void> {
  const target = process.env.EPO_PROBE_TARGET?.trim() ?? '';
  if (target === '') throw new Error('EPO_PROBE_TARGET (a public account we follow) is required');
  const reader = new Reader();
  const result: Record<string, unknown> = {};
  const observer = new ProfileObserver({ tab, reader, store: { observe: () => {} }, clock: new SystemClock() });
  const stopObserver = observer.start();
  // Every body the drawer fetches, parsed by the production Reader.
  const drawer: Array<Record<string, unknown>> = [];
  const stopDrawer = tab.onResponse((resp) => {
    const kind = reader.kindOf(resp);
    if (kind !== 'activity-feed' && kind !== 'friend-requests') return;
    resp.getBody().then(
      (body) => {
        const parsed =
          kind === 'activity-feed'
            ? { followEvents: reader.parseActivityFeedStrict(body)?.length ?? 'SHAPE_MISMATCH' }
            : { rows: reader.parseRequestsStrict(body, Date.now())?.observations.length ?? 'SHAPE_MISMATCH' };
        drawer.push({ kind, method: resp.method, status: resp.status, ...parsed });
      },
      (e: unknown) => drawer.push({ kind, error: String(e) }),
    );
  });
  const interactor = createTabInteractor(tab);
  const actor = new Actor(tab, { interactor });
  const visitor = new TabProfileVisitor({ tab, observer, sentinel: new Sentinel(tab) });
  // Every API exchange the page's own client makes, per step (evidence when a read goes quiet).
  const wc = webContents.getAllWebContents().find((c) => c.getURL().includes('instagram.com'));
  const rec = wc === undefined ? null : new TrafficRecorder(wc, out);
  rec?.start();
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    logger.info('probe.verify step', { step: name });
    rec?.setStep(name);
    result[name] = await fn().catch((e: unknown) => ({ threw: String(e) }));
    await settle();
    writeFileSync(path.join(out, `${name}.png`), await tab.captureScreenshot());
  };
  const summary = (v: Awaited<ReturnType<typeof visitor.visit>>): unknown =>
    v.ok
      ? { ok: true, pk: v.obs.accountPk, followers: v.obs.fields.followers, following: v.obs.fields.following, viewer: v.viewer }
      : v;
  try {
    const own = (await resolveOwnUsername(tab, { interactor })) ?? '';
    result.ownUsername = own;
    await step('visit-own', async () => summary(await visitor.visit(own)));
    await step('visit-target', async () => summary(await visitor.visit(target)));
    const nx = `epo_nx_${cryptoUniform().toString(36).slice(2, 10)}${cryptoUniform().toString(36).slice(2, 8)}`;
    await step('visit-nonexistent', async () => summary(await visitor.visit(nx)));
    await step('home', () => tab.goto(IG_HOME_URL));
    await step('drawer-open', () => actor.clickNotifications());
    await step('drawer-follows', () => actor.clickNotificationsFollowsFilter());
    await step('drawer-requests', () => actor.clickFollowRequestsEntry());
    await step('drawer-close', () => actor.clickNotificationsClose());
    result['drawer-closed'] = !(await tab.evaluate<{ found: boolean }>(SURFACE.locateNotificationsCloseScript())).found;
    await step('own-profile-link', async () => {
      const clicked = await actor.clickOwnProfileLink();
      await sleep(3000);
      return { clicked, url: tab.currentUrl() };
    });
  } finally {
    stopDrawer();
    stopObserver();
    rec?.stop();
    writeFileSync(path.join(out, 'traffic.json'), JSON.stringify(rec?.exchanges ?? [], null, 2), 'utf8');
    result.drawerBodies = drawer;
    writeFileSync(path.join(out, 'verify.json'), JSON.stringify(result, null, 2), 'utf8');
  }
}
