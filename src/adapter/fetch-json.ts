/**
 * `fetchJson` — one in-page JSON fetch, classified.
 *
 * Every read against Instagram's private API is an `evaluate` of a surface
 * fetch script that resolves to a {@link FetchEnvelope}. The five call sites
 * that used to hand-roll `evaluate → asFetchEnvelope → null? → !ok? → parse`
 * each classified the failure slightly differently — notably only the profile
 * enricher distinguished a definitive 404 from a transient wall. This is that
 * sequence once, with the classification the recovery ladder already speaks
 * ({@link classifyEnvelope}) attached to every failure.
 *
 * Nothing escapes: a destroyed tab is reported as its own `tab-unavailable`
 * family rather than as a generic failure, so a caller that must abort at once
 * (retrying cannot revive the tab) tests one field instead of a message.
 */

import { TabUnavailableError } from '@/adapter/errors';
import {
  asFetchEnvelope,
  classifyEnvelope,
  type EnvelopeKind,
  type FetchEnvelope,
  type SentinelStatus,
} from '@/adapter/ig-surface';
import type { Evaluable } from '@/adapter/tab-ports';
import { SURFACE_METER } from '@/surface/meter';

/** A 2xx JSON body. */
export interface FetchOk {
  ok: true;
  status: number;
  json: unknown;
}

/**
 * A fetch that did not yield a JSON body, with WHY:
 *
 *  - `classifyEnvelope`'s families (`rate-limited`, `auth`, `gone`, `network`,
 *    `drift-suspect`) when an envelope came back non-ok,
 *  - `no-envelope` when the evaluate resolved to something that is not an
 *    envelope at all (surface drift in the fetch script itself),
 *  - `tab-unavailable` when the tab's webContents is gone (terminal: retrying
 *    cannot revive it),
 *  - `threw` for any other evaluate rejection.
 */
export interface FetchFailure {
  ok: false;
  kind: Exclude<EnvelopeKind, 'ok'> | 'no-envelope' | 'threw' | 'tab-unavailable';
  /** HTTP status when one was observed; 0 for a throw or a non-envelope result. */
  status: number;
  /** The sentinel status of the wall the final URL matched, when one did. */
  wall?: SentinelStatus;
  /** The envelope when one came back — `null` for `no-envelope` / `threw`. */
  envelope: FetchEnvelope | null;
  /** Structured diagnostics for the caller's single warn line. */
  detail: Record<string, unknown>;
}

export type FetchResult = FetchOk | FetchFailure;

/** Evaluate a surface fetch script and classify its envelope. Never throws. */
export async function fetchJson(tab: Evaluable, script: string): Promise<FetchResult> {
  let raw: unknown;
  const startedAt = Date.now();
  try {
    raw = await tab.evaluate<unknown>(script);
  } catch (e) {
    return {
      ok: false,
      kind: e instanceof TabUnavailableError ? 'tab-unavailable' : 'threw',
      status: 0,
      envelope: null,
      detail: { error: String(e) },
    };
  }

  const env = asFetchEnvelope(raw);
  if (env === null) {
    return { ok: false, kind: 'no-envelope', status: 0, envelope: null, detail: {} };
  }
  if (env.ok) {
    // Successful samples only (see `SurfaceMeter`): a wall or an abort measures
    // the failure path, and feeding it back would inflate the abort deadline
    // that produced it.
    SURFACE_METER.record('list-page', Date.now() - startedAt);
    return { ok: true, status: env.status, json: env.json };
  }

  const cls = classifyEnvelope(env);
  return {
    ok: false,
    // `classifyEnvelope` only answers `ok` for an ok envelope, which is handled above.
    kind: cls.kind === 'ok' ? 'drift-suspect' : cls.kind,
    status: env.status,
    wall: cls.wall,
    envelope: env,
    detail: {
      status: env.status,
      contentType: env.contentType,
      textHead: env.textHead?.slice(0, 80) ?? null,
    },
  };
}
