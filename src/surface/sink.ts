/**
 * The surface sink (spec §10.7, Appendix D.1): the read pipeline reports each read's tally and drift
 * signal here, so one owner persists drift and health while `src/surface` stays pure. `MemorySink`
 * serves tests, the probe and the live test; main's production sink persists the same reports.
 */

import { driftConfirmThreshold } from '@/kernel/derive';
import { ENDPOINT_KINDS, type EndpointKind } from '@/surface/schema/endpoints';

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

/** One learned hint as a sink tracks it: distinct witnessed subjects, contradictions, its state. */
export interface HintView {
  readonly endpoint: DriftEndpoint; readonly cls: DriftClass; readonly role: RecoveryRole; readonly pattern: string;
  readonly witnesses: number; readonly contradictions: number; readonly state: 'open' | 'consistent' | 'contradicted';
}

/** Everything an in-memory sink has been told, in arrival order, with per-endpoint tallies and hints. */
export interface SurfaceHealthSnapshot {
  readonly reads: ReadonlyArray<{ readonly endpoint: DriftEndpoint; readonly tally: ReadTally; readonly rows: number;
    readonly fields: number; readonly at: number }>;
  readonly drift: ReadonlyArray<{ readonly signal: DriftSignal; readonly at: number }>;
  /** Reads per endpoint and tally (what the in-memory `SURFACE_HEALTH` counted). */
  readonly tallies: Readonly<Partial<Record<DriftEndpoint, Readonly<Partial<Record<ReadTally, number>>>>>>;
  readonly hints: readonly HintView[];
}

interface HintState { endpoint: DriftEndpoint; cls: DriftClass; role: RecoveryRole; pattern: string; subjects: Set<string>;
  contradictions: number }

/**
 * A sink that keeps every report in memory (tests, the probe, the live test); it never samples a body.
 * It is also a hint book: a hint is consistent once `threshold` distinct subjects agreed with none against.
 */
export class MemorySink implements SurfaceSink {
  private readonly reads: Array<SurfaceHealthSnapshot['reads'][number]> = [];
  private readonly drifts: Array<SurfaceHealthSnapshot['drift'][number]> = [];
  private readonly hintStates = new Map<string, HintState>();

  constructor(private readonly threshold: number = driftConfirmThreshold()) {}

  read(endpoint: DriftEndpoint, tally: ReadTally, issues: { readonly rows: number; readonly fields: number }, at: number): void {
    this.reads.push({ endpoint, tally, rows: issues.rows, fields: issues.fields, at });
  }

  drift(signal: DriftSignal, at: number): void {
    this.drifts.push({ signal, at });
    const { hint } = signal;
    if (hint === undefined) return;
    const key = `${signal.endpoint}|${signal.cls}|${hint.role}|${hint.pattern}`;
    const state = this.hintStates.get(key)
      ?? { endpoint: signal.endpoint, cls: signal.cls, role: hint.role, pattern: hint.pattern, subjects: new Set(), contradictions: 0 };
    if (!hint.agreed) state.contradictions += 1;
    else if (hint.subject !== null) state.subjects.add(hint.subject);
    this.hintStates.set(key, state);
  }

  private hintViews(): HintView[] {
    return [...this.hintStates.values()].map((h) => ({
      endpoint: h.endpoint, cls: h.cls, role: h.role, pattern: h.pattern, witnesses: h.subjects.size,
      contradictions: h.contradictions,
      state: h.contradictions > 0 ? 'contradicted' : h.subjects.size >= this.threshold ? 'consistent' : 'open',
    }));
  }

  /** Learned locations for an endpoint and role: consistent first, then open; contradicted never. */
  patterns(endpoint: EndpointKind, role: RecoveryRole): readonly string[] {
    const mine = this.hintViews().filter((h) => h.cls === 'recovered' && h.endpoint === endpoint && h.role === role);
    return [...mine.filter((h) => h.state === 'consistent'), ...mine.filter((h) => h.state === 'open')].map((h) => h.pattern);
  }

  /** Operation names learned for an endpoint family (consistent only). */
  learnedOps(): ReadonlyArray<{ readonly op: string; readonly kind: EndpointKind }> {
    return this.hintViews()
      .filter((h) => h.cls === 'unrouted' && h.state === 'consistent')
      .flatMap((h) => ((ENDPOINT_KINDS as readonly string[]).includes(h.endpoint) ? [{ op: h.pattern, kind: h.endpoint as EndpointKind }] : []));
  }

  snapshot(): SurfaceHealthSnapshot {
    const tallies: Partial<Record<DriftEndpoint, Partial<Record<ReadTally, number>>>> = {};
    for (const r of this.reads) {
      const row = tallies[r.endpoint] ?? {};
      row[r.tally] = (row[r.tally] ?? 0) + 1;
      tallies[r.endpoint] = row;
    }
    return { reads: [...this.reads], drift: [...this.drifts], tallies, hints: this.hintViews() };
  }
}

/** The default until the production sink is wired: reports go nowhere. */
export const NO_SINK: SurfaceSink = { read: () => {}, drift: () => {} };
