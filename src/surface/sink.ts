/**
 * The surface sink (spec §10.7, Appendix D.1): the read pipeline reports each
 * read's tally and each drift signal here, so drift and per-plan-day health are
 * persisted by one owner while `src/surface` stays pure. Phase F lands the port,
 * an in-memory sink and the record-nothing default; the parse-health stream
 * wires the production sink.
 */

import type { EndpointKind } from '@/surface/schema/endpoints';

export type DriftEndpoint = EndpointKind | 'mutation' | 'route';

export type DriftClass = 'normalized' | 'recovered' | 'unrouted' | 'expected-absent' | 'unexpected-null'
  | 'more-without-cursor' | 'cursor-veto' | 'end-claim-false' | 'no-continuation-evidence' | 'rows-unreadable'
  | 'row-issue' | 'mismatch' | 'ambiguous' | 'transport' | 'graphql-error' | 'graphql-partial' | 'incomplete-stream'
  | 'wall' | 'novel-key' | 'enum-novel' | 'shadow-disagreed'
  /** A later confirm layer whose text pass missed; nothing is pressed. */
  | 'confirm-unrecognized';

/** What a bounded structural recovery located (the recovery roles of spec §10.6). */
export type RecoveryRole = 'profile-user' | 'username-field' | 'feed-stories' | 'request-rows' | 'source-rows';

export interface DriftSignal {
  readonly endpoint: DriftEndpoint;
  readonly cls: DriftClass;
  /** A path pattern, never a value. */
  readonly path: string;
  /** Types, op names and counts only. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly hint?: { readonly role: RecoveryRole; readonly pattern: string; readonly subject: string | null; readonly agreed: boolean };
  /** The decoded body, scrubbed by the sink on a first sighting only. */
  readonly sample?: () => unknown;
}

export type ReadTally = 'canonical' | 'normalized' | 'recovered' | 'failed' | 'wall' | 'shadow-disagreed';

export interface SurfaceSink {
  read(endpoint: DriftEndpoint, tally: ReadTally, issues: { readonly rows: number; readonly fields: number }, at: number): void;
  drift(signal: DriftSignal, at: number): void;
}

/** Everything an in-memory sink has been told, in arrival order. */
export interface SurfaceHealthSnapshot {
  readonly reads: ReadonlyArray<{ readonly endpoint: DriftEndpoint; readonly tally: ReadTally; readonly rows: number;
    readonly fields: number; readonly at: number }>;
  readonly drift: ReadonlyArray<{ readonly signal: DriftSignal; readonly at: number }>;
}

/** A sink that keeps every report in memory (tests and the surface lab); it never samples a body. */
export class MemorySink implements SurfaceSink {
  private readonly reads: Array<SurfaceHealthSnapshot['reads'][number]> = [];
  private readonly drifts: Array<SurfaceHealthSnapshot['drift'][number]> = [];

  read(endpoint: DriftEndpoint, tally: ReadTally, issues: { readonly rows: number; readonly fields: number }, at: number): void {
    this.reads.push({ endpoint, tally, rows: issues.rows, fields: issues.fields, at });
  }

  drift(signal: DriftSignal, at: number): void {
    this.drifts.push({ signal, at });
  }

  snapshot(): SurfaceHealthSnapshot {
    return { reads: [...this.reads], drift: [...this.drifts] };
  }
}

/** The default until the production sink is wired: reports go nowhere. */
export const NO_SINK: SurfaceSink = { read: () => {}, drift: () => {} };
