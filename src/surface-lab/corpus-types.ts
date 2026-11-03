/**
 * The committed corpus's manifest vocabulary: one entry per body and DOM snapshot with what replaying it must
 * produce, plus provenance that names no payload. Shared by the capture scrubber and the probe ingester.
 */

import type { Source } from '@/store/types';
import type { ScrubStats } from '@/surface/lab/scrub';
import type { EndpointKind } from '@/surface/schema/endpoints';

/** One committed body, and what replaying it must produce. */
export interface CorpusBody {
  file: string;
  endpoint: EndpointKind;
  source: Source;
  /** The subject pk for endpoints whose body carries none. */
  pk?: string;
  /** Where it came from in the local capture (provenance, no payload). */
  origin: string;
  /** How the exchange was routed (probe-run corpora: the real path and GraphQL operation name). */
  route?: { method: string; path: string; op: string | null; via: 'url' | 'header' };
  status?: number | null;
  mime?: string | null;
  expect: {
    facts: number;
    relationships: number;
    events: number;
    cursor: string | null;
    hasMore: boolean;
    absent: boolean | null;
    rowIssues: number;
    novelKeys: string[];
  };
}

/** One committed DOM snapshot. */
export interface CorpusDom {
  file: string;
  kind: 'profile-header' | 'dialog';
  origin: string;
  bytes: number;
}

export interface CorpusManifest {
  /** The corpus directory's name, when it differs from the surface it replays against. */
  corpusId?: string;
  /** The capture day (a date, never an instant). */
  capturedAt?: string;
  surfaceId: string;
  scrubbedAt: string;
  replayAt: number;
  bodies: CorpusBody[];
  dom: CorpusDom[];
  /** Endpoints the local capture carried NO body for — the corpus's blind spots. */
  missing: EndpointKind[];
  /**
   * Files the residual check REFUSED to commit. A snapshot whose scrub left a
   * real identifier behind is dropped, never shipped: "if you cannot guarantee
   * a field is scrubbed, drop the fixture".
   */
  dropped: Array<{ origin: string; reason: string }>;
  stats: ScrubStats;
}

export interface ScrubOptions {
  /** The local capture directory (git-ignored real data). */
  sourceDir: string;
  /** The committed corpus directory. */
  outDir: string;
  /** Re-scrub the bodies only: `dom/` and its manifest entries stay byte-identical. */
  bodiesOnly?: boolean;
}

export interface ScrubOutcome {
  manifest: CorpusManifest;
  wrote: { bodies: number; dom: number };
}
