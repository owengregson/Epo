/**
 * READ-ONLY endpoint check (`EPO_PROBE=endpoints`): each REST read Epo composes,
 * asked ONCE, in sequence, 8–12 s apart — and the run STOPS at the first wall
 * (429, 5xx, or an HTML answer) so a dead endpoint is never asked twice and a
 * live one behind it is not asked into a throttle. Every hop is reported raw:
 * status, redirect, final URL, content type, top-level keys — never the body.
 *
 * `EPO_PROBE_TARGET` names a public account we follow (the friendship read).
 */

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolveOwnUsername } from '@/adapter/identity';
import { SURFACE } from '@/adapter/ig-surface';
import type { InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { electronIgSession } from '@/main/services/ig-session';
import { PATHS } from '@/surface/versions/2026-08-12/literals';
import { sleep } from '@/timing/primitives';

interface Hop {
  status: number;
  redirected: boolean;
  finalUrl: string;
  contentType: string;
  bytes: number;
  keys: string[] | null;
  head: string | null;
  /** Small scalar facts pulled from the JSON (never row data). */
  facts: Record<string, unknown> | null;
}

/** One page-context GET with Epo's production headers, summarised. */
const hop = (url: string, factsJs: string): string => `(async function () {
  var r = await fetch(${JSON.stringify(url)}, { headers: { 'x-ig-app-id': '${SURFACE.appId}' }, credentials: 'include', signal: AbortSignal.timeout(20000) });
  var ct = r.headers.get('content-type') || '';
  var text = await r.text();
  var j = null;
  if (ct.indexOf('json') !== -1) { try { j = JSON.parse(text); } catch (e) {} }
  var facts = null;
  if (j) { try { facts = (function (j) { return ${factsJs}; })(j); } catch (e) { facts = { factsThrew: String(e) }; } }
  return { status: r.status, redirected: r.redirected, finalUrl: r.url, contentType: ct, bytes: text.length,
    keys: j && typeof j === 'object' ? Object.keys(j) : null, head: j ? null : text.slice(0, 160), facts: facts };
})()`;

const isWall = (h: Hop): boolean =>
  h.status === 429 || h.status >= 500 || h.status === 0 || !/json/i.test(h.contentType);

export async function endpointCheck(tab: InstagramTab, out: string): Promise<void> {
  const target = process.env.EPO_PROBE_TARGET?.trim() ?? '';
  const ownPk = await electronIgSession().readCookie('ds_user_id');
  // The DOM strategies resolve this locally; `current_user` is not reached while they work.
  const ownUsername = (await resolveOwnUsername(tab, { interactor: createTabInteractor(tab) })) ?? '';
  if (ownPk === null || target === '' || ownUsername === '') throw new Error('needs ds_user_id, EPO_PROBE_TARGET and a DOM-resolved username');
  const steps: Array<{ name: string; url: string; facts: string }> = [
    {
      name: 'topsearch',
      url: `${PATHS.topsearch}${encodeURIComponent(ownUsername)}`,
      facts: `{ users: Array.isArray(j.users) ? j.users.length : null, exact: Array.isArray(j.users) && j.users.some(function (u) { return u && u.user && String(u.user.username).toLowerCase() === ${JSON.stringify(ownUsername.toLowerCase())}; }), status: j.status, message: j.message }`,
    },
    {
      name: 'users-info',
      url: `${PATHS.usersPrefix}${ownPk}${PATHS.profileInfoSuffix}`,
      facts: `{ user: !!j.user, userKeys: j.user ? Object.keys(j.user).length : null, hasCounts: !!j.user && typeof j.user.follower_count === 'number' && typeof j.user.following_count === 'number', status: j.status, message: j.message }`,
    },
    {
      name: 'friendship-show',
      url: '<resolved below>',
      facts: `{ keys: Object.keys(j), following: j.following, followed_by: j.followed_by, status: j.status, message: j.message }`,
    },
  ];
  const result: Record<string, unknown> = { ownPk, target };
  // The target's pk without asking Instagram: the profile page's own GraphQL
  // body was recorded by the traffic phase; the caller passes it in.
  const targetPk = process.env.EPO_PROBE_TARGET_PK?.trim() ?? '';
  steps[2].url = `${PATHS.friendshipShow}${targetPk}/`;
  for (const [i, step] of steps.entries()) {
    if (step.name === 'friendship-show' && targetPk === '') {
      result[step.name] = 'skipped: no EPO_PROBE_TARGET_PK';
      continue;
    }
    if (i > 0) await sleep(8000 + Math.random() * 4000);
    const h = await tab.evaluate<Hop>(hop(step.url, step.facts)).catch((e: unknown) => ({ threw: String(e) }));
    result[step.name] = h;
    if ('threw' in h || isWall(h)) {
      result.stoppedAt = step.name;
      break;
    }
  }
  writeFileSync(path.join(out, 'endpoints.json'), JSON.stringify(result, null, 2), 'utf8');
}
