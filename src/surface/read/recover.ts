/**
 * C2 recovery (spec §10.6): a body whose declared container is gone is searched, under a role's
 * witness (an anchor or an arm), for the one place its record or rows moved to. A recovered read only
 * ever adds facts: tier `recovered`, a list's continuation never recovered, every destructive sink refusing it.
 */

import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { resolveContainer } from '@/surface/read/normalize';
import { candidates, defaultEnv, readOnce } from '@/surface/read/read';
import { reportRead } from '@/surface/read/report';
import type { ReadCtx, ReadEnv, ReadMeta, SurfaceRead } from '@/surface/read/types';
import type { RecoveryRole } from '@/surface/recovery/hints';
import { locate } from '@/surface/recovery/locate';
import { requesterRow, usernameFieldOf, userRow } from '@/surface/recovery/signatures';
import type { EndpointKind } from '@/surface/schema/endpoints';
import type { Projection } from '@/surface/schema/projection';
import type { DriftSignal } from '@/surface/sink';
import type { Decoded } from '@/surface/transport/decode';
import * as logger from '@/utils/logger';

/** The role a body is recovered under; own lists, relationship checks and mutations never are. */
const ROLE_OF: Partial<Record<EndpointKind, RecoveryRole>> = {
  'profile-graphql': 'profile-user', 'activity-feed': 'feed-stories', 'friend-requests': 'request-rows',
  'followers-list': 'source-rows',
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A C2 read of rows: only rows that hold their invariants count; the page's continuation is never read. */
function rowsProjection(rows: readonly unknown[], keep: (r: unknown) => boolean, project: (page: unknown) => Projection,
  rowsKey: string): Projection {
  const kept = rows.filter(keep);
  const p = project({ [rowsKey]: kept });
  const quarantined = rows.length - kept.length;
  return { ...p, continuation: null, cursor: null, hasMore: false, fieldIssues: [],
    rowIssues: [...p.rowIssues, ...Array.from({ length: quarantined }, (_, i) => ({ index: kept.length + i, path: '(row)', message: 'recovery-invariant' }))] };
}

/** Recover one decoded body as `kind` (never throws); a failure is typed and nothing is reported but an ambiguity. */
export function recoverBody(kind: EndpointKind, decoded: Decoded, ctx: ReadCtx, env: ReadEnv = defaultEnv()): SurfaceRead {
  try {
    return recoverOnce(kind, decoded, ctx, env);
  } catch (e) {
    logger.warn('surface.recover: the search threw', { endpoint: kind, error: e instanceof Error ? e.name : typeof e });
    return { ok: false, kind: 'mismatch', issues: [{ path: '(body)', message: 'recovery threw' }], keys: [], endpoint: kind };
  }
}

function recoverOnce(kind: EndpointKind, decoded: Decoded, ctx: ReadCtx, env: ReadEnv): SurfaceRead {
  const role = ROLE_OF[kind];
  const refuse = (message: string): SurfaceRead =>
    ({ ok: false, kind: 'mismatch', issues: [{ path: '(body)', message }], keys: [], endpoint: kind });
  if (role === undefined) return refuse('not recoverable');
  const direct = readOnce(kind, { decoded }, ctx, env);
  const decl = env.doc.read.recovery;
  const defs = candidates(kind, ctx, env);
  const def = defs[0]?.def;
  if (!decoded.ok || def === undefined) return direct.read;
  const json = decoded.json;
  const subject = (pk: string | null): string | null => ctx.anchor?.pk ?? pk;
  const meta = (located: ReadMeta['located']): Omit<ReadMeta, 'endpoint'> =>
    ({ tier: 'recovered', partial: decoded.final === false || (direct.read.ok && direct.read.partial), steps: [], route: ctx.route?.via ?? 'url',
      novelKeys: [], ...(located === undefined ? {} : { located }) });
  const finish = (projection: Projection, located: NonNullable<ReadMeta['located']>, pk: string | null,
    contradicted?: string): SurfaceRead => {
    const read: SurfaceRead = { ok: true, projection, endpoint: kind, ...meta(located) };
    const hint = { role: located.role, pattern: located.pattern, subject: subject(pk), agreed: true };
    reportRead(read, ctx.at, env.sink, { partial: null, novelty: [], sample: () => json, hint });
    if (contradicted !== undefined) {
      const against: DriftSignal = { endpoint: kind, cls: 'recovered', path: contradicted, detail: { role: located.role },
        hint: { ...hint, pattern: contradicted, agreed: false } };
      env.sink.drift(against, ctx.at);
    }
    return read;
  };
  // A record found at its declared place: a candidate's or a learned operation's route makes it C2 and it is
  // reported here; a canonically routed read was reported by its own read already.
  const reported = (): SurfaceRead => {
    const via = ctx.route?.via;
    if (via === 'candidate' || via === 'learned') {
      reportRead(direct.read, ctx.at, env.sink, { partial: direct.partial, novelty: env.doc.read.novelty[kind] ?? [], sample: () => json });
    }
    return direct.read;
  };
  // A routed record that only lost its username: exactly one top-level field carrying the anchor's name (C2).
  if (direct.read.ok && kind === 'profile-graphql') {
    const fact = direct.read.projection.facts[0];
    if (fact === undefined || fact.fields.username !== undefined || ctx.anchor === undefined) return reported();
    const found = resolveContainer(defs, json, env.doc.read.continuation);
    const field = found.kind === 'value' && isRecord(found.value) ? usernameFieldOf(found.value, ctx.anchor) : null;
    if (field === null || found.kind !== 'value') return reported();
    const projection = def.project({ ...(found.value as Record<string, unknown>), [decl.handleKey]: (found.value as Record<string, unknown>)[field] },
      { at: ctx.at, source: def.source ?? 'profile', viewerPk: ctx.viewerPk ?? null, root: json, steps: [] });
    return finish(projection, { role: 'username-field', pattern: field, via: 'search' }, fact.accountPk);
  }
  if (direct.read.ok) return reported();
  if (direct.read.kind !== 'mismatch') return direct.read;
  const bodyBytes = JSON.stringify(json)?.length ?? 0;
  const located = locate({ role, endpoint: kind, body: json, bodyBytes, anchor: ctx.anchor, arm: ctx.arm, decl,
    hints: env.hints.patterns(kind, role), identity: env.identity });
  if (!located.ok) {
    if (located.reason === 'ambiguous') {
      env.sink.drift({ endpoint: kind, cls: 'ambiguous', path: '(body)', detail: { role, candidates: located.candidates } }, ctx.at);
      return { ok: false, kind: 'ambiguous', candidates: located.candidates, endpoint: kind };
    }
    return refuse(`recovery ${located.reason}`);
  }
  const projectCtx = { at: ctx.at, source: ctx.source ?? def.source ?? 'profile', viewerPk: ctx.viewerPk ?? null, root: json, steps: [] };
  const where = { role, pattern: located.pattern, via: located.via } as const;
  if (role === 'profile-user') {
    const projection = def.project(located.value, projectCtx);
    return finish(projection, where, projection.facts[0]?.accountPk ?? null, located.contradictedHint);
  }
  if (role === 'feed-stories') return finish({ ...def.project(located.value, projectCtx), pendingPreview: [] }, where, null, located.contradictedHint);
  const rows = Array.isArray(located.value) ? located.value : [];
  const keep = role === 'request-rows' ? (r: unknown) => requesterRow(r, decl) : (r: unknown) => userRow(r, decl) !== null;
  const projection = rowsProjection(rows, keep, (page) => def.project(page, projectCtx), env.doc.read.continuation.rowsKey);
  if (projection.facts.length < SURFACE_BOUNDS.rowMajority * rows.length) {
    return { ok: false, kind: 'rows-unreadable', rows: rows.length, quarantined: rows.length - projection.facts.length, endpoint: kind };
  }
  return finish(projection, where, null, located.contradictedHint);
}

