/**
 * READ-ONLY header experiment (`EPO_PROBE=headers`): TWO requests, both the
 * exact request Instagram's own followers dialog makes (`count=12`,
 * `search_surface=follow_list_page`, our own pk) — once with the headers Epo
 * sends today, once with the header set the web client was recorded sending
 * (`EPO_PROBE=traffic`). Discriminates "the endpoint moved" from "the request
 * contract changed" at the cost of two ordinary dialog-sized reads. Also reads
 * locally (no network) which header SOURCES the page exposes.
 */

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { SURFACE } from '@/adapter/ig-surface';
import type { InstagramTab } from '@/adapter/tab';
import { electronIgSession } from '@/main/services/ig-session';
import { sleep } from '@/timing/primitives';

/** Page-context fetch of `url` with `headers`, summarised (never the body). */
const trial = (url: string, headers: string): string => `(async function () {
  var h = ${headers};
  var r = await fetch(${JSON.stringify(url)}, { headers: h, credentials: 'include' });
  var ct = r.headers.get('content-type') || '';
  var text = await r.text();
  var keys = null, rows = null;
  if (ct.indexOf('json') !== -1) { try { var j = JSON.parse(text); keys = Object.keys(j); rows = Array.isArray(j.users) ? j.users.length : null; } catch (e) {} }
  return { status: r.status, redirected: r.redirected, finalUrl: r.url, contentType: ct, bytes: text.length,
    keys: keys, rows: rows, sentHeaders: Object.keys(h), head: keys ? null : text.slice(0, 160) };
})()`;

/** The client's header set, built from what the page itself holds. */
const CLIENT_HEADERS = `(function () {
  var m = document.cookie.match(/(?:^|;\\s*)csrftoken=([^;]+)/);
  return {
    'x-ig-app-id': '${SURFACE.appId}',
    'x-asbd-id': '359341',
    'x-csrftoken': m ? decodeURIComponent(m[1]) : '',
    'x-ig-www-claim': sessionStorage.getItem('www-claim-v2') || '0',
    'x-requested-with': 'XMLHttpRequest',
    'x-ig-max-touch-points': String(navigator.maxTouchPoints || 0),
  };
})()`;

/** Local reads only: where each header value could come from. */
const SOURCES = `({
  csrfCookie: /(?:^|;\\s*)csrftoken=/.test(document.cookie),
  sessionKeys: Object.keys(sessionStorage),
  localKeys: Object.keys(localStorage).filter(function (k) { return /claim|session|asbd|csrf/i.test(k); }),
  maxTouchPoints: navigator.maxTouchPoints,
})`;

export async function headerExperiment(tab: InstagramTab, out: string): Promise<void> {
  const ownPk = await electronIgSession().readCookie('ds_user_id');
  if (ownPk === null) throw new Error('no ds_user_id cookie');
  const url = `/api/v1/friendships/${ownPk}/followers/?count=12&search_surface=follow_list_page`;
  const result: Record<string, unknown> = { sources: await tab.evaluate<unknown>(SOURCES) };
  result.epoHeaders = await tab.evaluate<unknown>(trial(url, `{ 'x-ig-app-id': '${SURFACE.appId}' }`));
  await sleep(6000 + Math.random() * 4000);
  result.clientHeaders = await tab.evaluate<unknown>(trial(url, CLIENT_HEADERS));
  writeFileSync(path.join(out, 'headers.json'), JSON.stringify(result, null, 2), 'utf8');
}
