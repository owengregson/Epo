/**
 * Surface health (spec §10.7, Appendix D.1): the areas a changed Instagram surface affects, their
 * states, the status push's summary and the Diagnostics report. Renderer-safe and pure; the gate is
 * `surface-gate.ts`'s, re-exported here, and the labels are the parse-health stream's.
 */
import type { PausedActivity } from './surface-gate';

export { NEVER_PAUSED, type PausedActivity, type SurfaceGate } from './surface-gate';

export const SURFACE_AREAS = [
  'profiles', 'notifications', 'follow-requests', 'lists', 'relationship-checks', 'follow-actions',
] as const;
export type SurfaceArea = (typeof SURFACE_AREAS)[number];

export type AreaState = 'ok' | 'adapting' | 'paused' | 'unreadable' | 'limited' | 'unseen';

/** The adapter's measured quantities (`src/surface/meter.ts` measures them), restated import-free. */
export const SURFACE_METERS = ['hydration', 'mutation-arrival', 'list-page', 'body-read', 'scroll-settle'] as const;
export type SurfaceMeter = (typeof SURFACE_METERS)[number];

/** The status push's slice (`EpoStatus.surface`). */
export interface SurfaceSummary {
  readonly revision: number;
  /** The worst area's state. */
  readonly worst: AreaState;
  readonly areas: Readonly<Record<SurfaceArea, AreaState>>;
  readonly paused: readonly PausedActivity[];
  readonly adapting: boolean;
  readonly attention: ReadonlyArray<{ readonly area: SurfaceArea; readonly state: AreaState;
    readonly paused: readonly PausedActivity[]; readonly since: number }>;
}

/** One area in the report, with today's read tallies. */
export interface AreaReport {
  area: SurfaceArea;
  state: AreaState;
  paused: readonly PausedActivity[];
  lastReadAt: number | null;
  today: { canonical: number; normalized: number; recovered: number; failed: number; walls: number;
    rowIssues: number; fieldIssues: number };
}

/** One recorded change in how a response arrives. */
export interface SurfaceChange {
  area: SurfaceArea;
  endpoint: string;
  cls: string;
  /** A `FIELD_LABEL` key. */
  field: string | null;
  path: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seen: number;
  state: 'open' | 'consistent' | 'contradicted';
  witnesses: number;
  hint: string | null;
  hasSample: boolean;
}

/** A meter's sample count and percentiles; null percentiles before any sample. */
export interface MeterReading { n: number; p50: number | null; p95: number | null }

/** The Diagnostics report (`surface:report`). */
export interface SurfaceReport {
  readonly surfaceId: string;
  readonly generatedAt: number;
  readonly areas: ReadonlyArray<AreaReport>;
  readonly changes: ReadonlyArray<SurfaceChange>;
  readonly meter: Readonly<Record<SurfaceMeter, MeterReading>>;
  /** Built in main: no usernames, pks or values; scrubbed samples included. */
  readonly copyText: string;
}
