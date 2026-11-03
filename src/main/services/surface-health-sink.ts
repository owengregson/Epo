/**
 * The production surface sink (spec §10.7; the one writer of `surface_drift`, `surface_health` and
 * `meta.surface_meter`, §4.2). Read tallies buffer per plan-day and endpoint and flush on the push throttle's
 * trailing edge, at a plan-day roll and at teardown; a signature is written at once, with a scrubbed sample.
 */

import type { Clock } from '@/governors/clock';
import { driftConfirmThreshold } from '@/kernel/derive';
import type { PlanDayClock } from '@/kernel/plan';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { MS_PER_DAY } from '@/kernel/units';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { HealthDelta } from '@/store/repos/surface-drift';
import { SURFACE_METER, type SurfaceMeter } from '@/surface/meter';
import { ENDPOINT_KINDS, type EndpointKind } from '@/surface/schema/endpoints';
import type { DriftEndpoint, DriftSignal, ReadTally, RecoveryRole, SurfaceSink } from '@/surface/sink';
import { POLL } from '@/timing/config';
import * as logger from '@/utils/logger';

/** Classes whose first sighting keeps a scrubbed sample: the evidence a root-cause fix needs. */
const SAMPLED = new Set(['recovered', 'unrouted', 'mismatch', 'ambiguous', 'expected-absent', 'more-without-cursor',
  'cursor-veto', 'end-claim-false', 'no-continuation-evidence', 'rows-unreadable', 'shadow-disagreed']);
/** Classes whose sighting is a warn; every other class logs at info. */
const WARNS = new Set([...SAMPLED, 'unexpected-null', 'row-issue', 'transport', 'confirm-unrecognized']);

export interface SurfaceHealthSinkDeps {
  store: KnowledgeStore;
  surfaceId: string;
  day: PlanDayClock;
  clock: Clock;
  /** Scrub a decoded body into a stored sample, or null when nothing safe remains. */
  scrub: (endpoint: DriftEndpoint, decoded: unknown) => string | null;
  /** Distinct agreeing subjects for a consistent hint, clean reads to resolve (default `driftConfirmThreshold()`). */
  threshold?: number;
  meter?: SurfaceMeter;
  /** Runs `fn` after `ms` and returns its cancel (default: an unreferenced timer). */
  after?: (ms: number, fn: () => void) => () => void;
}

/** The sink, its hint book and identity oracle over the store, and its flush. */
export interface SurfaceHealthSink extends SurfaceSink {
  patterns(endpoint: EndpointKind, role: RecoveryRole): readonly string[];
  learnedOps(): ReadonlyArray<{ readonly op: string; readonly kind: EndpointKind }>;
  usernameOf(pk: string): string | undefined;
  flush(): void;
  dispose(): void;
}

const timer = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const zero = (): HealthDelta => ({ canonical: 0, normalized: 0, recovered: 0, failed: 0, walls: 0, rowIssues: 0,
  fieldIssues: 0, shadowDisagreed: 0, readAt: null, okAt: null, failAt: null });
const later = (a: number | null, b: number): number => (a === null ? b : Math.max(a, b));

export function createSurfaceHealthSink(d: SurfaceHealthSinkDeps): SurfaceHealthSink {
  const repo = d.store.surface;
  const threshold = d.threshold ?? driftConfirmThreshold();
  const meter = d.meter ?? SURFACE_METER;
  const after = d.after ?? timer;
  const pending = new Map<string, { day: string; endpoint: string; delta: HealthDelta; clean: number }>();
  const logged = new Set<string>();
  let cancel: (() => void) | null = null;
  let unroll: (() => void) | null = null;
  let disposed = false;

  const prune = (now: number): void =>
    repo.prune({ healthDays: SURFACE_BOUNDS.healthRetentionDays, maxPerEndpoint: SURFACE_BOUNDS.maxSignaturesPerEndpoint,
      resolvedBefore: now - SURFACE_BOUNDS.driftRetentionDays * MS_PER_DAY });

  const flush = (): void => {
    cancel?.();
    cancel = null;
    const at = d.clock.now();
    for (const p of pending.values()) {
      repo.addHealth(p.day, d.surfaceId, p.endpoint, p.delta);
      if (p.clean > 0) repo.noteCleanRead(d.surfaceId, p.endpoint, null, at, threshold, p.clean);
    }
    pending.clear();
    // The reservoirs are written only when they changed: an idle teardown writes nothing.
    const dump = meter.dump();
    const text = JSON.stringify(dump);
    if (text !== storedMeter && (storedMeter !== null || Object.keys(dump.samples).length > 0)) {
      repo.setMeter(text);
      storedMeter = text;
    }
  };

  // The roll subscription is taken on the first report, so a sink that never hears one arms no timer.
  const touched = (): void => {
    unroll ??= d.day.onRoll(() => {
      flush();
      prune(d.clock.now());
      logged.clear();
    });
    if (cancel === null && !disposed) cancel = after(POLL.GRAPH_PUSH_THROTTLE_MS, flush);
  };

  const sample = (signature: string, signal: DriftSignal, at: number): void => {
    if (signal.sample === undefined || !SAMPLED.has(signal.cls)) return;
    if (repo.samplesSince(d.surfaceId, d.day.window(at).startsAt) >= SURFACE_BOUNDS.samplesPerDay) return;
    const text = d.scrub(signal.endpoint, signal.sample());
    if (text === null) logger.info('surface: sample dropped, its detail is kept', { endpoint: signal.endpoint, cls: signal.cls });
    else repo.setSample(signature, text);
  };

  // Retention at open; an update that shipped resolves every signature of the surface it replaced.
  let storedMeter = repo.meter();
  if (storedMeter !== null && !meter.restore(safeJson(storedMeter))) logger.warn('surface: the stored meter is unreadable; it starts cold');
  repo.resolveOtherSurfaces(d.surfaceId, d.clock.now());
  prune(d.clock.now());

  return {
    read(endpoint: DriftEndpoint, tally: ReadTally, issues: { readonly rows: number; readonly fields: number }, at: number): void {
      if (disposed) return;
      const day = d.day.dayKey(at);
      const key = `${day}|${endpoint}`;
      const p = pending.get(key) ?? { day, endpoint, delta: zero(), clean: 0 };
      const delta = p.delta;
      if (tally === 'wall') delta.walls += 1;
      else if (tally === 'shadow-disagreed') delta.shadowDisagreed += 1;
      else delta[tally] += 1;
      delta.rowIssues += issues.rows;
      delta.fieldIssues += issues.fields;
      delta.readAt = later(delta.readAt, at);
      if (tally === 'canonical' || tally === 'normalized' || tally === 'recovered') delta.okAt = later(delta.okAt, at);
      if (tally === 'failed') delta.failAt = later(delta.failAt, at);
      if (tally === 'canonical' && issues.rows === 0 && issues.fields === 0) p.clean += 1;
      pending.set(key, p);
      touched();
    },
    drift(signal: DriftSignal, at: number): void {
      if (disposed) return;
      const signature = `${d.surfaceId}|${signal.endpoint}|${signal.cls}|${signal.path}`;
      const detail = JSON.stringify(signal.hint === undefined ? signal.detail : { ...signal.detail, role: signal.hint.role });
      const { firstSighting, row } = repo.upsertSignal({ signature, surfaceId: d.surfaceId, endpoint: signal.endpoint,
        cls: signal.cls, path: signal.path, detail, at, hintPattern: signal.hint?.pattern ?? null });
      if (signal.hint !== undefined && (signal.hint.subject !== null || !signal.hint.agreed)) {
        repo.witness(signature, signal.hint.subject ?? '', signal.hint.agreed, at, threshold);
      }
      if (firstSighting) sample(signature, signal, at);
      // Repeats are counted, not logged: one line per signature per plan-day, carrying the running count.
      const once = `${d.day.dayKey(at)}|${signature}`;
      if (!logged.has(once)) {
        logged.add(once);
        (WARNS.has(signal.cls) ? logger.warn : logger.info)('surface: drift', {
          endpoint: signal.endpoint, cls: signal.cls, path: signal.path, seen: row.seen, detail: signal.detail });
      }
      touched();
    },
    patterns: (endpoint, role) => repo.hintPatterns(d.surfaceId, endpoint, role),
    learnedOps: () => repo.learnedOps(d.surfaceId)
      .flatMap((h) => ((ENDPOINT_KINDS as readonly string[]).includes(h.kind) ? [{ op: h.op, kind: h.kind as EndpointKind }] : [])),
    usernameOf: (pk) => d.store.getAccount(pk)?.username ?? undefined,
    flush,
    dispose(): void {
      if (disposed) return;
      flush();
      disposed = true;
      unroll?.();
      unroll = null;
    },
  };
}

/** Parse stored JSON; a corrupt value parses to undefined, which the meter refuses (it stays cold, with a warn). */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
