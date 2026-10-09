/**
 * READ-ONLY passive probe (`EPO_PROBE=traffic`): browse the way a person does —
 * home, our own profile, one other profile, our followers and following
 * dialogs, the notifications drawer — and record every API exchange
 * INSTAGRAM'S OWN CLIENT makes on the way. Epo composes ZERO requests here:
 * this is the ground truth for which endpoints the web client uses today, and
 * with which headers, before Epo is pointed at any of them. DOM checks are
 * local reads of the controls the Actor drives (no network).
 *
 * `EPO_PROBE_TARGET` names the other profile (a public account we follow).
 */

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { webContents } from 'electron';
import { Actor } from '@/adapter/actor';
import { resolveOwnUsername } from '@/adapter/identity';
import { SURFACE } from '@/adapter/ig-surface';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { type Exchange, TrafficRecorder } from '@/probe/recorder';
import { sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';

/** A person-paced settle after each step: 5–8 s. */
const settle = (): Promise<void> => sleep(5000 + Math.random() * 3000);

/** The Actor's controls, read in place (each is a local DOM query). */
async function domCheck(tab: InstagramTab, names: string[]): Promise<Record<string, unknown>> {
  const scripts: Record<string, () => string> = {
    'followers-stat': () => SURFACE.locateFollowersStatScript(),
    'following-stat': () => SURFACE.locateFollowingStatScript(),
    'profile-link': () => SURFACE.locateProfileLinkScript(),
    'profile-href': () => SURFACE.readProfileHrefScript(),
    'avatar-alt': () => SURFACE.readAvatarAltScript(),
    'notifications-link': () => SURFACE.locateNotificationsLinkScript(),
    'action-state': () => SURFACE.probeStateScript(),
    'action-unfollow': () => SURFACE.locateActionButtonScript('unfollow'),
    'list-scroller': () => SURFACE.locateScrollContainerScript(),
    'dialog-present': () => SURFACE.dialogPresentScript(),
    'follows-filter': () => SURFACE.locateNotificationsFollowsFilterScript(),
    'requests-entry': () => SURFACE.locateFollowRequestsEntryScript(),
    'drawer-close': () => SURFACE.locateNotificationsCloseScript(),
    'drawer-scroller': () => SURFACE.locateNotificationsScrollScript(),
    'block-text': () => SURFACE.bodyTextProbeScript(),
  };
  const out: Record<string, unknown> = {};
  for (const name of names) {
    out[name] = await tab.evaluate<unknown>(scripts[name]()).catch((e: unknown) => ({ threw: String(e) }));
  }
  return out;
}

/** One line per distinct (method, path template, operation): what the client calls. */
function summarize(exchanges: Exchange[]): string[] {
  const rows = new Map<string, { count: number; statuses: Set<string>; steps: Set<string>; kind: string | null }>();
  for (const ex of exchanges) {
    const op = ex.form?.fb_api_req_friendly_name ?? ex.headers['x-fb-friendly-name'] ?? '';
    const key = `${ex.method} ${ex.path.replace(/\/\d+(?=\/)/g, '/<n>')}${op ? `  [${op}]` : ''}`;
    const row = rows.get(key) ?? { count: 0, statuses: new Set(), steps: new Set(), kind: ex.epoKind };
    row.count += 1;
    row.statuses.add(`${ex.status ?? ex.failed ?? '?'}${ex.mime ? ` ${ex.mime}` : ''}`);
    row.steps.add(ex.step);
    rows.set(key, row);
  }
  return [...rows.entries()].map(
    ([key, r]) =>
      `${key}  ×${r.count}  -> ${[...r.statuses].join(', ')}  epo=${r.kind ?? '-'}  steps=${[...r.steps].join(',')}`,
  );
}

export async function traffic(tab: InstagramTab, out: string): Promise<void> {
  const target = process.env.EPO_PROBE_TARGET?.trim() ?? '';
  if (target === '') throw new Error('EPO_PROBE_TARGET (a public account we follow) is required');
  const wc = webContents.getAllWebContents().find((c) => c.getURL().includes('instagram.com'));
  if (wc === undefined) throw new Error('no Instagram webContents to record');
  const save = (name: string, value: unknown): void =>
    writeFileSync(path.join(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');

  const rec = new TrafficRecorder(wc, out);
  const actor = new Actor(tab, { interactor: createTabInteractor(tab) });
  const dom: Record<string, unknown> = {};
  const outcome: Record<string, unknown> = {};
  const run = async (step: string, fn: () => Promise<unknown>, checks: string[] = []): Promise<void> => {
    rec.setStep(step);
    logger.info('probe.traffic step', { step });
    try {
      outcome[step] = (await fn()) ?? 'done';
    } catch (e) {
      outcome[step] = { threw: (e as Error)?.constructor?.name ?? 'unknown', message: String(e) };
    }
    await settle();
    if (checks.length > 0) dom[step] = await domCheck(tab, checks);
  };

  rec.start();
  try {
    await run('home', () => tab.goto(IG_HOME_URL), ['profile-link', 'profile-href', 'avatar-alt', 'notifications-link', 'block-text']);
    const own = (await resolveOwnUsername(tab, { interactor: createTabInteractor(tab) })) ?? null;
    outcome.ownUsername = own;
    if (own === null) return;
    await run('own-profile', () => tab.goto(SURFACE.profileUrl(own)), ['followers-stat', 'following-stat']);
    await run('target-profile', () => tab.goto(SURFACE.profileUrl(target)), ['action-state', 'action-unfollow', 'followers-stat', 'following-stat']);
    await run('target-followers-dialog', () => actor.openFollowersDialog(target), ['dialog-present', 'list-scroller']);
    await run('target-followers-scroll', () => actor.scrollFollowers());
    await run('own-followers-dialog', () => actor.openFollowersDialog(own), ['dialog-present', 'list-scroller']);
    await run('own-following-dialog', () => actor.openFollowingDialog(own), ['dialog-present', 'list-scroller']);
    await run('home-again', () => tab.goto(IG_HOME_URL));
    await run('notifications-open', () => actor.clickNotifications(), ['follows-filter', 'requests-entry', 'drawer-close', 'drawer-scroller']);
    await run('notifications-follows', () => actor.clickNotificationsFollowsFilter());
    await run('follow-requests', () => actor.clickFollowRequestsEntry());
    await run('notifications-close', () => actor.clickNotificationsClose());
  } finally {
    await sleep(3000); // let the last bodies land
    rec.stop();
    save('traffic.json', rec.exchanges);
    save('dom.json', dom);
    save('outcome.json', outcome);
    save('summary.txt', summarize(rec.exchanges).join('\n'));
  }
}
