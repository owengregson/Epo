/**
 * The surface report (spec §10.7): the area view over the persisted drift and health rows, the status
 * summary the `surface` contributor pushes, the surface gate both the click review and the plan mix read,
 * and the full report the compatibility panel pulls. The view is recomputed only when the drift repo wrote
 * or the plan-day changed.
 */

import type { Clock } from '@/governors/clock';
import { driftConfirmThreshold } from '@/kernel/derive';
import type { PlanDayClock } from '@/kernel/plan';
import {
  AREA_LABEL, type AreaReport, changeLine, explanation, fieldOf, type MeterReading, PAUSED_LABEL, STATE_LABEL,SURFACE_METERS,
  type SurfaceChange, type SurfaceGate, type SurfaceMeter, type SurfaceReport, type SurfaceSummary, 
} from '@/shared/surface-health';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { HealthRow } from '@/store/repos/surface-drift';
import { type AreaView, areaOf, createSurfaceGate, deriveAreas, summarize } from '@/surface/health-view';
import { type SurfaceMeter as Meter, SURFACE_METER } from '@/surface/meter';

export interface SurfaceReportDeps {
  store: KnowledgeStore;
  surfaceId: string;
  day: PlanDayClock;
  clock: Clock;
  /** Drifted pages, failure streak and clean reads that decide a state (default `driftConfirmThreshold()`). */
  threshold?: number;
  meter?: Meter;
}

export interface SurfaceReporter {
  /** Every area's state, from persisted rows only. */
  areas(): readonly AreaView[];
  summary(): SurfaceSummary;
  report(): SurfaceReport;
  gate: SurfaceGate;
}

/** A long digit run in copied text (an id, a shifted time): never leaves Epo, even scrubbed. */
const LONG_DIGITS = /\d{6,}/g;
const iso = (ms: number): string => new Date(ms).toISOString();

const tallies = (rows: readonly HealthRow[]): AreaReport['today'] => ({
  canonical: rows.reduce((n, r) => n + r.canonical, 0), normalized: rows.reduce((n, r) => n + r.normalized, 0),
  recovered: rows.reduce((n, r) => n + r.recovered, 0), failed: rows.reduce((n, r) => n + r.failed, 0),
  walls: rows.reduce((n, r) => n + r.walls, 0), rowIssues: rows.reduce((n, r) => n + r.rowIssues, 0),
  fieldIssues: rows.reduce((n, r) => n + r.fieldIssues, 0),
});

/** The text Copy report puts on the clipboard: states, changes, paths, counts and scrubbed samples, no id. */
function copyText(r: Omit<SurfaceReport, 'copyText'>, samples: ReadonlyMap<SurfaceChange, string>): string {
  const lines = [`Epo · Instagram compatibility report`, `Surface ${r.surfaceId} · generated ${iso(r.generatedAt)}`, '', 'Areas'];
  for (const a of r.areas) {
    const t = a.today;
    const paused = a.paused.length === 0 ? '' : ` · paused: ${a.paused.map((p) => PAUSED_LABEL[p]).join(', ')}`;
    lines.push(`- ${AREA_LABEL[a.area]}: ${STATE_LABEL[a.state]}${paused} · today ${t.canonical} canonical, ${t.normalized}` +
      ` normalized, ${t.recovered} recovered, ${t.failed} failed, ${t.walls} limited, ${t.rowIssues} row issues, ` +
      `${t.fieldIssues} field issues`);
    const why = explanation(a.area, a.state, a.paused, a.lastReadAt === null ? null : iso(a.lastReadAt));
    if (why !== '') lines.push(`  ${why}`);
  }
  lines.push('', 'Changes');
  if (r.changes.length === 0) lines.push('- none');
  for (const c of r.changes) {
    lines.push(`- ${changeLine(c, iso)}`, `  ${c.endpoint} · ${c.cls} · ${c.path} · ${c.state} · last seen ${iso(c.lastSeenAt)}` +
      `${c.hint === null ? '' : ` · hint ${c.hint}`}`);
    const sample = samples.get(c);
    if (sample !== undefined) lines.push(`  sample: ${sample}`);
  }
  lines.push('', 'Typical load');
  for (const m of SURFACE_METERS) {
    const s = r.meter[m];
    lines.push(`- ${m}: ${s.n} samples, p50 ${s.p50 ?? '–'} ms, p95 ${s.p95 ?? '–'} ms`);
  }
  return lines.join('\n').replace(LONG_DIGITS, '#');
}

export function createSurfaceReport(d: SurfaceReportDeps): SurfaceReporter {
  const threshold = d.threshold ?? driftConfirmThreshold();
  const meter = d.meter ?? SURFACE_METER;
  let cached: { key: string; areas: readonly AreaView[] } | null = null;

  const areas = (): readonly AreaView[] => {
    const today = d.day.dayKey(d.clock.now());
    const key = `${d.store.surface.revision}|${today}`;
    if (cached?.key !== key) {
      const rows = d.store.surface.openSignatures(d.surfaceId);
      const health = d.store.surface.health(d.surfaceId, '');
      cached = { key, areas: deriveAreas(rows, health, today, threshold) };
    }
    return cached.areas;
  };

  const report = (): SurfaceReport => {
    const now = d.clock.now();
    const today = d.day.dayKey(now);
    const health = d.store.surface.health(d.surfaceId, '');
    const of = (area: string, rows: readonly HealthRow[]): HealthRow[] => rows.filter((h) => areaOf(h.endpoint) === area);
    const areaRows: AreaReport[] = areas().map((a) => {
      const reads = of(a.area, health).map((h) => h.lastReadAt).filter((t): t is number => t !== null);
      return { area: a.area, state: a.state, paused: a.paused, lastReadAt: reads.length === 0 ? null : Math.max(...reads),
        today: tallies(of(a.area, health.filter((h) => h.day === today))) };
    });
    const samples = new Map<SurfaceChange, string>();
    const changes = d.store.surface.openSignatures(d.surfaceId).flatMap((r): SurfaceChange[] => {
      const area = areaOf(r.endpoint);
      if (area === null || r.state === 'resolved') return [];
      const change: SurfaceChange = { area, endpoint: r.endpoint, cls: r.cls, field: fieldOf(r.path), path: r.path,
        firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, seen: r.seen, state: r.state, witnesses: r.witnesses,
        hint: r.hintPattern, hasSample: r.sample !== null };
      if (r.sample !== null) samples.set(change, r.sample);
      return [change];
    });
    const readings = Object.fromEntries(SURFACE_METERS.map((m): [SurfaceMeter, MeterReading] => {
      const s = meter.summary(m);
      return [m, { n: s.n, p50: s.p50, p95: s.p95 }];
    })) as Record<SurfaceMeter, MeterReading>;
    const base = { surfaceId: d.surfaceId, generatedAt: now, areas: areaRows, changes, meter: readings };
    return { ...base, copyText: copyText(base, samples) };
  };

  return {
    areas,
    summary: () => summarize(areas(), d.store.surface.revision),
    report,
    gate: createSurfaceGate(areas),
  };
}
