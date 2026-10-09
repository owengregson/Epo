/**
 * SurfaceHealth — drift as a METRIC, not an exception.
 *
 * `SHAPE_MISMATCH` today dies in a log line, so nobody knows whether Instagram
 * changed last night or last month. This counts, per endpoint: bodies parsed,
 * bodies that failed their schema, bodies carrying a key the schema does not
 * know (the earliest signal there is — weeks before a break), and when the last
 * mismatch happened.
 *
 * In-memory this wave. The store table is a wave-B seam: `snapshot()` is
 * already the row shape a `surface_observations` table would hold, and the
 * projection that pushes it to the UI rides the existing `onMutation` →
 * throttled-projection path (PRINCIPLES §2) with no new plumbing.
 */

import type { EndpointKind } from '@/surface/schema/endpoints';

/** One endpoint's running counters. */
export interface EndpointHealth {
  endpoint: EndpointKind;
  parsed: number;
  mismatch: number;
  /** Bodies that parsed but carried at least one unknown key. */
  novel: number;
  /** Rows a row schema rejected inside an otherwise-valid body. */
  rowIssues: number;
  /**
   * Bodies where the schema and the legacy extractor DISAGREED while the
   * endpoint is in `observe` mode. This is the number that earns the right to
   * flip an endpoint to `enforce`.
   */
  disagreed: number;
  lastMismatchAt: number | null;
  lastNovelKeys: readonly string[];
}

/** The whole surface's health, newest counters first. */
export interface SurfaceHealthSnapshot {
  surfaceId: string;
  endpoints: readonly EndpointHealth[];
  /** Totals across endpoints — what a status card shows at a glance. */
  totals: { parsed: number; mismatch: number; novel: number; disagreed: number };
}

const blank = (endpoint: EndpointKind): EndpointHealth => ({
  endpoint,
  parsed: 0,
  mismatch: 0,
  novel: 0,
  rowIssues: 0,
  disagreed: 0,
  lastMismatchAt: null,
  lastNovelKeys: [],
});

export class SurfaceHealth {
  private readonly rows = new Map<EndpointKind, EndpointHealth>();
  private readonly surfaceId: string;

  constructor(surfaceId: string) {
    this.surfaceId = surfaceId;
  }

  private row(endpoint: EndpointKind): EndpointHealth {
    let row = this.rows.get(endpoint);
    if (row === undefined) {
      row = blank(endpoint);
      this.rows.set(endpoint, row);
    }
    return row;
  }

  parsed(endpoint: EndpointKind, opts: { novelKeys?: readonly string[]; rowIssues?: number } = {}): void {
    const row = this.row(endpoint);
    row.parsed += 1;
    row.rowIssues += opts.rowIssues ?? 0;
    if (opts.novelKeys && opts.novelKeys.length > 0) {
      row.novel += 1;
      row.lastNovelKeys = opts.novelKeys;
    }
  }

  mismatch(endpoint: EndpointKind, at: number): void {
    const row = this.row(endpoint);
    row.mismatch += 1;
    row.lastMismatchAt = at;
  }

  /** The schema and the legacy extractor produced different facts (observe mode). */
  disagreed(endpoint: EndpointKind): void {
    this.row(endpoint).disagreed += 1;
  }

  snapshot(): SurfaceHealthSnapshot {
    const endpoints = [...this.rows.values()].map((r) => ({ ...r }));
    const totals = endpoints.reduce(
      (acc, r) => ({
        parsed: acc.parsed + r.parsed,
        mismatch: acc.mismatch + r.mismatch,
        novel: acc.novel + r.novel,
        disagreed: acc.disagreed + r.disagreed,
      }),
      { parsed: 0, mismatch: 0, novel: 0, disagreed: 0 },
    );
    return { surfaceId: this.surfaceId, endpoints, totals };
  }

  /** Drop every counter (test isolation; a fresh session starts cold). */
  reset(): void {
    this.rows.clear();
  }
}
