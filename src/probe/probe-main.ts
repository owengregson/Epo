/**
 * Live session probe: EPO_PROBE_OUT=<outside-repo dir> EPO_PROBE=<phase> npm run probe.
 * The ./phases.ts phases and health/following/followers are read-only;
 * follow performs ONE follow/unfollow pair of EPO_PROBE_TARGET, only after health passes, without retries.
 * Uses production userData, partition, identity and background switches.
 * Output contains real account data; EPO_PROBE_OUT must be outside the repo.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { Actor } from '@/adapter/actor';
import { fetchJson } from '@/adapter/fetch-json';
import { resolveOwnUsername } from '@/adapter/identity';
import { SURFACE } from '@/adapter/ig-surface';
import { Reader } from '@/adapter/reader';
import { Sentinel } from '@/adapter/sentinel';
import type { InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { classifyRequest } from '@/capture/classify';
import { SystemClock } from '@/governors/clock';
import { awaitLogin, bootstrapApp, ensureInstagramOrigin, openToolWindow } from '@/main/bootstrap';
import { applyNetworkBlock, electronIgSession } from '@/main/services/ig-session';
import { SOLO_PHASES } from '@/probe/phases';
import { launchVerify } from '@/probe/verify-launch';
import { ListPageWalker } from '@/rim/list-page-walker';
import { ProfileObserver } from '@/rim/profile-observer';
import { TabProfileVisitor } from '@/rim/profile-visit';
import { sleep } from '@/timing/primitives';
import { cryptoUniform } from '@/utils/entropy';
import * as logger from '@/utils/logger';

bootstrapApp();
const PHASE = process.env.EPO_PROBE ?? 'health';
const OUT = process.env.EPO_PROBE_OUT ?? '';
const TARGET = process.env.EPO_PROBE_TARGET?.trim() ?? '';
const FOLLOW_HOLD_MS = 45_000; // between the probe's follow and its unfollow
const save = (name: string, value: unknown): void => writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2), 'utf8');
interface Health {
  sentinel: string;
  ownPk: string | null;
  ownUsername: string | null;
  header: { following: number | null; followers: number | null } | null;
  profileRead: string;
}

async function health(tab: InstagramTab): Promise<Health> {
  const sentinel = await new Sentinel(tab).check();
  // What the PAGE says it is vs what the runtime is — read locally, no request.
  const browser = await tab.evaluate<unknown>(
    `({ ua: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands : null, platform: navigator.userAgentData ? navigator.userAgentData.platform : null })`,
  );
  save('browser.json', { page: browser, runtimeChrome: process.versions.chrome, electron: process.versions.electron });
  const ownPk = await electronIgSession().readCookie('ds_user_id');
  const out: Health = { sentinel, ownPk, ownUsername: null, header: null, profileRead: 'skipped' };
  if (sentinel !== 'ok' || ownPk === null) return out;
  // Production's resolver (page-only strategies) and its diagnosis of each step.
  out.ownUsername = (await resolveOwnUsername(tab, { interactor: createTabInteractor(tab) })) ?? null;
  if (out.ownUsername === null) return { ...out, profileRead: 'no-username' };
  // Production's profile read: a VISIT. The probe's observer writes nowhere.
  const observer = new ProfileObserver({ tab, reader: new Reader(), store: { observe: () => {} }, clock: new SystemClock() });
  const stop = observer.start();
  try {
    const visit = await new TabProfileVisitor({ tab, observer, sentinel: new Sentinel(tab) }).visit(out.ownUsername);
    if (!visit.ok) return { ...out, profileRead: visit.kind };
    const f = visit.obs.fields;
    return { ...out, profileRead: 'ok', header: { following: f.following ?? null, followers: f.followers ?? null } };
  } finally {
    stop();
  }
}

/** One list-page request as the walker made it, and what came back. */
interface PageRecord {
  n: number;
  cursorSent: string | null;
  ok: boolean;
  status: number;
  rows: number | null;
  nextMaxId: unknown;
  hasMore: unknown;
  bigList: unknown;
  otherKeys: string[];
  newPks: number;
  pks: string[];
}

async function walk(tab: InstagramTab, ownPk: string, which: 'followers' | 'following'): Promise<void> {
  const pages: PageRecord[] = [];
  const seen = new Set<string>();
  // The production walker, fed a tab that records each list-page evaluate.
  const recording = new Proxy(tab, {
    get(target, prop, receiver) {
      if (prop !== 'evaluate') {
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (script: string): Promise<unknown> => {
        const result = await target.evaluate<unknown>(script);
        const at = typeof script === 'string' ? /\/(?:followers|following)\/\?count=/.exec(script) : null;
        if (at === null) return result;
        const cursor = /max_id=' \+ encodeURIComponent\("([^"]*)"\)/.exec(script)?.[1] ?? null;
        const env = result as { ok?: boolean; status?: number; json?: Record<string, unknown> };
        const users = Array.isArray(env.json?.users) ? (env.json?.users as Array<{ pk?: unknown }>) : null;
        const pks = (users ?? []).map((u) => String(u.pk));
        const fresh = pks.filter((p) => !seen.has(p));
        for (const p of fresh) seen.add(p);
        pages.push({
          n: pages.length + 1,
          cursorSent: cursor,
          ok: env.ok === true,
          status: env.status ?? -1,
          rows: users?.length ?? null,
          nextMaxId: env.json?.next_max_id ?? null,
          hasMore: env.json?.has_more ?? null,
          bigList: env.json?.big_list ?? null,
          otherKeys: Object.keys(env.json ?? {}).filter((k) => k !== 'users'),
          newPks: fresh.length,
          pks,
        });
        return result;
      };
    },
  });
  const walker = new ListPageWalker({ tab: recording, reader: new Reader() });
  const result = await walker.walkAll({
    pk: ownPk,
    which,
    onObservation: () => {},
    sentinel: new Sentinel(tab),
  });
  save(`walk-${which}.json`, {
    result: { ...result, pks: result.pks.length },
    unique: seen.size,
    pages: pages.map(({ pks, ...meta }) => meta),
  });
  save(`walk-${which}-pks.json`, pages.map((p) => ({ n: p.n, pks: p.pks })));
}

/**
 * READ-ONLY. Open our own following dialog and scroll it a few rounds, recording
 * the list requests INSTAGRAM'S OWN CLIENT makes — the parameters a walk that
 * wants the same stable paging has to send.
 */
async function dialogRequests(tab: InstagramTab, ownUsername: string): Promise<void> {
  const seen: unknown[] = [];
  const off = tab.onResponse((res) => {
    if (!/\/friendships\/\d+\/(?:followers|following)\//.test(res.url)) return;
    const url = new URL(res.url);
    const entry = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: res.method, status: res.status };
    seen.push(entry);
    res.getBody().then(
      (body) => {
        const json = safeParse(body) as Record<string, unknown>;
        const users = Array.isArray(json.users) ? json.users.length : null;
        Object.assign(entry, { rows: users, nextMaxId: json.next_max_id ?? null, rankingToken: json.follow_ranking_token ?? null });
      },
      () => {},
    );
  });
  const actor = new Actor(tab, { interactor: createTabInteractor(tab) });
  try {
    await actor.openFollowingDialog(ownUsername);
    for (let i = 0; i < 4; i++) {
      await sleep(2500);
      await actor.scrollFollowers();
    }
    await sleep(3000);
  } finally {
    off();
    save('dialog-requests.json', seen);
  }
}

/**
 * READ-ONLY experiment: page a 10-page window of the UNSTABLE zone of our own
 * following list (row offsets 1400–1850; the baseline walk repeats 67 of those
 * 500 rows) with one extra query parameter, and count within-window repeats.
 * `EPO_PROBE_PARAM` is `rank` (echo page 1's ranking token) or a literal
 * `key=value`. Production pacing; 10–11 requests.
 */
async function windowExperiment(tab: InstagramTab, ownPk: string): Promise<void> {
  const param = process.env.EPO_PROBE_PARAM ?? '';
  const page = async (extra: string, maxId: number | null): Promise<Record<string, unknown> | null> => {
    // The PRODUCTION page request, with the one extra parameter spliced in.
    const script = SURFACE.listPageScript(ownPk, 'following', maxId === null ? null : String(maxId));
    const res = await fetchJson(tab, script.replace("/following/?count=50'", `/following/?count=50${extra}'`));
    await sleep(1500 + cryptoUniform() * 1500);
    return res.ok ? (res.json as Record<string, unknown>) : null;
  };
  let extra = param === '' || param === 'rank' ? '' : `&${param}`;
  if (param === 'rank') {
    const head = await page('', null);
    extra = `&rank_token=${encodeURIComponent(String(head?.follow_ranking_token ?? ''))}`;
  }
  const seen = new Set<string>();
  const pages: unknown[] = [];
  let repeats = 0;
  for (let offset = 1400; offset < 1900; offset += 50) {
    const json = await page(extra, offset);
    const users = Array.isArray(json?.users) ? (json?.users as Array<{ pk?: unknown }>) : null;
    const pks = (users ?? []).map((u) => String(u.pk));
    const dup = pks.filter((p) => seen.has(p)).length;
    for (const p of pks) seen.add(p);
    repeats += dup;
    pages.push({ offset, rows: users?.length ?? null, dup, nextMaxId: json?.next_max_id ?? null });
    // A response that ignored the page size answered the WHOLE list: asking again
    // only re-downloads it (the mistake that soft-walled this form on 2026-09-20).
    if (users === null || users.length > 50 || json?.next_max_id == null) break;
  }
  save(`window-${param.replace(/[^a-z_=]/gi, '') || 'plain'}.json`, { param, repeats, unique: seen.size, pages });
}

async function followOnce(tab: InstagramTab): Promise<void> {
  if (TARGET === '') throw new Error('EPO_PROBE_TARGET is required for the follow phase');
  const posts: unknown[] = [];
  let bodies = 0;
  const off = tab.onResponse((res) => {
    if (res.method?.toUpperCase() !== 'POST') return;
    const kind = classifyRequest(res);
    const entry = {
      at: Date.now(),
      path: new URL(res.url).pathname,
      status: res.status,
      mime: res.mimeType,
      friendlyName: SURFACE.friendlyName(res.requestHeaders) ?? null,
      kind,
      matched: SURFACE.matchMutation(res),
    };
    posts.push(entry);
    if (!kind.startsWith('mutation')) return;
    const name = `mutation-${++bodies}-${kind}.json`;
    res.getBody().then(
      (body) => save(name, { ...entry, body: safeParse(body) }),
      (e: unknown) => logger.warn('probe: mutation body unreadable', { error: String(e) }),
    );
  });
  const actor = new Actor(tab, { interactor: createTabInteractor(tab) });
  const outcome: Record<string, unknown> = { target: TARGET };
  try {
    outcome.follow = await settle(() => actor.follow(TARGET));
    // Only undo a follow THIS probe pressed — an already-followed target answers
    // ok without a click, and unfollowing it would remove the owner's own follow.
    const f = outcome.follow as { ok?: boolean; value?: { clicked?: boolean } };
    if (f.ok === true && f.value?.clicked === true) {
      await sleep(FOLLOW_HOLD_MS);
      outcome.unfollow = await settle(() => actor.unfollow(TARGET));
    }
  } finally {
    await sleep(3000); // let the last bodies land
    off();
    save('follow-posts.json', { outcome, posts });
  }
}

const safeParse = (body: string): unknown => {
  try { return JSON.parse(body); } catch { return { unparsed: body.slice(0, 600) }; }
};

/** Run an action once; an exception is an OUTCOME here, recorded by class + message. */
async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (e) {
    return { threw: (e as Error)?.constructor?.name ?? 'unknown', message: String(e) };
  }
}
async function main(): Promise<void> {
  if (OUT === '' || path.resolve(OUT).startsWith(process.cwd())) {
    throw new Error('EPO_PROBE_OUT must name a directory OUTSIDE the repository');
  }
  mkdirSync(OUT, { recursive: true });
  await applyNetworkBlock();
  if (PHASE === 'verify') return launchVerify(OUT, TARGET);
  const tool = openToolWindow({ title: `Epo — live probe (${PHASE})` });
  await tool.ready;
  if (!(await awaitLogin(tool.isOpen))) return;
  await ensureInstagramOrigin(tool.tab);
  await sleep(4000); // hydration
  const solo = SOLO_PHASES[PHASE]; // phases that replace the health reads (./phases.ts)
  if (solo !== undefined) return solo(tool.tab, OUT);
  const h = await health(tool.tab);
  save('health.json', h);
  logger.info('probe: health', h);
  const clean = h.sentinel === 'ok' && h.ownPk !== null && h.profileRead === 'ok';
  if (PHASE === 'health' || !clean) return;
  if (PHASE === 'following' || PHASE === 'followers') await walk(tool.tab, h.ownPk as string, PHASE);
  if (PHASE === 'window') await windowExperiment(tool.tab, h.ownPk as string);
  if (PHASE === 'dialog') await dialogRequests(tool.tab, h.ownUsername as string);
  if (PHASE === 'follow') await followOnce(tool.tab);
}

app.whenReady().then(() =>
  main()
    .catch((e: unknown) => {
      logger.error('probe: failed', { error: String(e) });
      if (OUT !== '') save('error.json', { error: String(e) });
    })
    .finally(() => app.quit()),
);
