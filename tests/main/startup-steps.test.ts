/**
 * The startup steps over the real Foundation and store (spec §12.8): confirm-account confirms, rebuilds while
 * idle or leaves an inconclusive identity alone; its passive read never presses or navigates; a Start during
 * the sequence is queued (never `manual-running`); manual work and prune get `'starting'`; login no longer
 * shows the tab; a store a newer build migrated is `unavailable` with its typed problem; a seed restart
 * retires the old sources so the frontier never revisits them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstagramTab } from '@/adapter/tab';
import { SourceFrontier } from '@/engine/source-frontier';
import type { Foundation } from '@/main/foundation-wiring';
import type { GraphSession } from '@/main/modules/session';
import { readOwnUsernamePassively } from '@/main/modules/startup-steps';
import { openDatabase } from '@/store/driver/index';
import { MIGRATIONS } from '@/store/schema';
import type { EpoStatus } from '@/types';
import { cleanupMainHarness, foundationStore, makeFakeTab, newFoundation, tempUserData } from '../kit/main-harness';

afterAll(cleanupMainHarness);

const sessionOf = (f: Foundation): GraphSession => (f as unknown as { session: GraphSession }).session;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A tab already on a profile page, recording every navigation and press-shaped call. */
function profileTab(username: string, over: Partial<Record<string, unknown>> = {}): { tab: InstagramTab; calls: string[] } {
  const calls: string[] = [];
  const tab = makeFakeTab({
    goto: async (url: string) => { calls.push(`goto:${url}`); },
    show: () => { calls.push('show'); },
    currentUrl: () => `https://www.instagram.com/${username}/`,
    evaluate: async <T>(): Promise<T> => { calls.push('evaluate'); return null as T; },
    ...over,
  });
  return { tab, calls };
}

async function booted(f: Foundation): Promise<void> {
  const booting = f.startBoot();
  f.bootRevealed();
  await booting;
}

test('confirm-account rebuilds an idle graph with the signed-in username and marks the account confirmed', async () => {
  const pushed: EpoStatus[] = [];
  const { tab } = profileTab('owen');
  const { foundation: f } = newFoundation({ tab, onStatus: (s) => pushed.push(s) });
  await booted(f);
  expect(sessionOf(f).current()?.ownUsername).toBe('owen');
  expect((await f.status()).account).toEqual({ username: 'owen', confirmed: true });
  expect((await f.status()).boot).toMatchObject({ phase: 'live', ig: 'ready', startup: { done: true } });
  const steps = pushed.map((s) => s.boot?.startup.step).filter((s) => s !== null && s !== undefined);
  expect([...new Set(steps)]).toEqual(['open-own-profile', 'confirm-account']);
  await f.dispose();
});

test('an equal username confirms without a rebuild; an inconclusive read leaves the graph unconfirmed', async () => {
  const userDataDir = tempUserData();
  const seed = newFoundation({ userDataDir });
  await seed.foundation.ensureBuilt();
  foundationStore(seed.foundation).observe({ accountPk: '4242', observedAt: Date.now(), source: 'profile', fields: { username: 'owen' } });
  await seed.foundation.dispose();

  const same = newFoundation({ userDataDir, tab: profileTab('owen').tab }).foundation;
  await same.ensureBuilt();
  const graph = sessionOf(same).current();
  await booted(same);
  expect(sessionOf(same).current()).toBe(graph);
  expect((await same.status()).account).toEqual({ username: 'owen', confirmed: true });
  await same.dispose();

  const home = makeFakeTab({ currentUrl: () => 'https://www.instagram.com/accounts/onetap/', evaluate: async <T>() => null as T });
  const unsure = newFoundation({ userDataDir, tab: home }).foundation;
  await booted(unsure);
  expect((await unsure.status()).account).toEqual({ username: 'owen', confirmed: false });
  await unsure.dispose();
});

test('the passive identity read only evaluates: no navigation, no press', async () => {
  const calls: string[] = [];
  const tab = {
    evaluate: async <T>(script: unknown): Promise<T> => {
      calls.push(`evaluate:${typeof script}`);
      return (calls.length === 1 ? '/owen/' : null) as T;
    },
  };
  expect(await readOwnUsernamePassively(tab, new AbortController().signal)).toBe('owen');
  expect(calls).toEqual(['evaluate:string']);
  const aborted = new AbortController();
  aborted.abort();
  expect(await readOwnUsernamePassively(tab, aborted.signal)).toBeUndefined();
});

test('a Start during the sequence is queued, never manual-running, and starts after the release', async () => {
  const { tab } = profileTab('owen');
  const { foundation: f } = newFoundation({ tab });
  await f.updateSettings({ activeHoursStart: 8, activeHoursEnd: 8, pacingModel: 'legacy' });
  const booting = f.startBoot();
  await flush();
  const start = f.startEngine();
  await flush();
  expect((await f.status()).boot?.startup.startQueued).toBe(true);
  expect(await f.readFollowers('someone')).toMatchObject({ ok: false, reason: 'starting' });
  expect(await f.followOne('someone')).toMatchObject({ ok: false, reason: 'starting' });
  expect(await f.scanPrune()).toMatchObject({ ok: false, reason: 'starting' });
  expect(await f.startPrune()).toMatchObject({ ok: false, reason: 'starting' });
  f.bootRevealed();
  await booting;
  const status = await start;
  expect(status.refusal).toBeUndefined();
  expect(status.state).toBe('running');
  await f.stopEngine();
  await f.dispose();
});

test('Stop during the sequence cancels a queued Start', async () => {
  const { foundation: f } = newFoundation({ tab: profileTab('owen').tab });
  const booting = f.startBoot();
  await flush();
  const start = f.startEngine();
  await flush();
  await f.stopEngine();
  f.bootRevealed();
  await booting;
  expect((await start).refusal).toBe('runtime-intent-changed');
  expect((await f.status()).state).toBe('idle');
  await f.dispose();
});

test('login no longer shows the tab; it loads home and runs the identity steps under the lease', async () => {
  const { tab, calls } = profileTab('owen');
  const { foundation: f } = newFoundation({ tab });
  await booted(f);
  calls.length = 0;
  await f.login();
  await flush();
  expect(calls).not.toContain('show');
  expect(calls).toEqual(['goto:https://www.instagram.com/']);
  await f.dispose();
});

test('a store a newer build migrated is unavailable, with the typed problem, and never a fabricated graph', async () => {
  const userDataDir = tempUserData();
  const raw = openDatabase(path.join(userDataDir, 'epo.db'));
  raw.pragma('user_version', MIGRATIONS.length + 1);
  raw.close();
  const { foundation: f } = newFoundation({ userDataDir, tab: profileTab('owen').tab });
  await booted(f);
  const status = await f.status();
  expect(status.basis).toBe('not-built');
  expect(status.boot).toMatchObject({ identity: 'signed-in', data: 'unavailable', dataProblem: 'future-version' });
  expect(fs.existsSync(path.join(userDataDir, 'epo.db'))).toBe(true);
  await f.dispose();
});

test('a seed restart retires the active sources, and the frontier never brings them back', async () => {
  const { foundation: f } = newFoundation();
  await f.ensureBuilt();
  const store = foundationStore(f);
  store.addTarget({ accountPk: '777', source: 'seed', status: 'active', chainIndex: store.nextChainIndex() });
  jest.spyOn(f, 'startEngine').mockResolvedValue(await f.status());
  await f.restartFromSeed('newseed');
  expect(store.getTarget('777')?.status).toBe('retired');
  const frontier = new SourceFrontier({ store, clock: { now: () => Date.now() } as never }).snapshot();
  expect(frontier.sources.map((s) => s.pk)).not.toContain('777');
  jest.restoreAllMocks();
  await f.dispose();
});
