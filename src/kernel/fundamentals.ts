/**
 * Tier 0 — what we believe about the world.
 *
 * Every entry is a MEASUREMENT or a cited estimate, never a tuning knob: if you
 * find yourself nudging a number here to make a derived constant come out
 * "right", the number belongs in {@link ../kernel/policy POLICY} or in
 * {@link ../kernel/overrides OVERRIDES} instead.
 *
 * Each entry carries `src` (where the belief comes from) and `rev` (when it was
 * last reviewed, `YYYY-MM`). A test fails when any `rev` is more than twelve
 * months behind the review date — stale beliefs are the failure mode that
 * derivation exists to surface.
 *
 * Layering: `src/kernel/**` imports NOTHING from the rest of `src/`. The unit
 * multipliers it needs are declared locally in `derive.ts`.
 *
 * See docs/adr/0605-constants-derive-from-fundamentals.md.
 */

/** Provenance carried by every empirical entry. */
export interface Provenance {
  /** Where the belief comes from — a run, an incident, a paper, a community band. */
  readonly src: string;
  /** `YYYY-MM` the belief was last reviewed against evidence. */
  readonly rev: string;
}

/** A rate wall: the low end we have seen bite, and the typical onset. */
export interface WallBand extends Provenance {
  readonly low: number;
  readonly typical: number;
}

/** Latency percentiles for one measured operation class, in milliseconds. */
export interface LatencyOpSeed extends Provenance {
  readonly p50: number;
  readonly p95?: number;
  readonly p99: number;
}

const MIN = 60_000;

/**
 * The measured/estimated quantities every derived constant is a function of.
 *
 * The `LATENCY.*` and `ORDINARY_*` entries are SEEDS: the spans table (wave B)
 * replaces them with the install's own measured quantiles, at which point the
 * derivations below re-evaluate. Until then they are honest estimates chosen to
 * reproduce the timeouts the app shipped with — which is why the golden test
 * against `tests/kernel/legacy-config.snapshot.ts` is the real proof, not these.
 */
export const EMPIRICAL = {
  /** Soft follow-wall onset per hour, established account. */
  FOLLOW_WALL_PER_HOUR: {
    low: 30,
    typical: 60,
    src: 'observed soft-wall onset; ADR 0202 pacing band (20–30/hr safe ⇒ ~60/hr onset)',
    rev: '2026-09',
  } satisfies WallBand,
  /** Soft follow-wall onset per day, established account. */
  FOLLOW_WALL_PER_DAY: {
    low: 100,
    typical: 150,
    src: 'established-account community reports + 2026-08 live runs (100–150/day)',
    rev: '2026-09',
  } satisfies WallBand,
  /** Unfollow walls track follow walls closely enough to share the band. */
  UNFOLLOW_WALL_PER_HOUR: {
    low: 30,
    typical: 60,
    src: '2026-08-15 prune incident: the unfollow wall bit at the same hourly band',
    rev: '2026-09',
  } satisfies WallBand,
  /** How long a soft rate wall stays up once hit, in HOURS. */
  SOFT_WALL_DURATION_H: {
    p50: 3,
    p90: 24,
    src: '2026-08-15 prune incident + recovery-ladder tuning runs',
    rev: '2026-09',
  },
  /** Inactivity after which a human browsing session is considered over. */
  HUMAN_SESSION_BOUNDARY_MS: {
    value: 30 * MIN,
    src: 'Catledge & Pitkow 1995; the GA4 default session timeout',
    rev: '2026-09',
  },
  /** Within-session inter-action gap: log-normal median and log-space spread. */
  HUMAN_GAP: {
    medianMs: 95_000,
    sigma: 0.75,
    src: 'WWW-2015 browsing-cluster shape',
    rev: '2026-09',
  },
  /** How many distinct sessions a day a real user opens the app. */
  HUMAN_SESSIONS_PER_DAY: {
    min: 2,
    max: 9,
    src: 'diurnal-corpus session counts (WWW-2015 cohort)',
    rev: '2026-09',
  },
  /** Day-to-day coefficient of variation in a human's action volume. */
  HUMAN_DAY_VOLUME_CV: {
    value: 0.28,
    src: 'diurnal-corpus daily-volume dispersion',
    rev: '2026-09',
  },
  /** Fraction of days a real user does (near) nothing. */
  HUMAN_REST_DAY_RATE: {
    value: 0.08,
    src: 'diurnal-corpus zero-activity day rate (~1 per two weeks)',
    rev: '2026-09',
  },
  /** Within-session self-excitation (clustering that winds down): Hawkes kernel. */
  HUMAN_BURST: {
    alpha: 0.35,
    tauMs: 90_000,
    src: 'sub-critical Hawkes fit to browsing clusters (branching ratio n≈α<1)',
    rev: '2026-09',
  },
  /** The diurnal-weekly shape of human activity. */
  HUMAN_CIRCADIAN: {
    bumps: [
      { centerHour: 8.0, amplitude: 0.45, widthHours: 1.6 },
      { centerHour: 13.0, amplitude: 0.5, widthHours: 2.0 },
      { centerHour: 18.0, amplitude: 1.0, widthHours: 3.0 },
    ],
    /** λ is never exactly zero — real traces carry rare 3am actions. */
    overnightFloor: 0.015,
    /** Sun..Sat (`Date.getDay()` order). */
    dayOfWeek: [0.9, 1.0, 1.08, 1.08, 1.0, 1.02, 0.92],
    /** On Sat/Sun the whole curve shifts this many hours later. */
    weekendShiftHours: 1.4,
    src: 'diurnal-corpus studies: morning-commute / lunch / dominant evening peak',
    rev: '2026-09',
  },

  // --- MEASURED BY THE APP (seeded here, learned at runtime from the spans table) ---

  /** Latency percentiles per operation class, milliseconds. */
  LATENCY: {
    /** SPA hydration after `goto` resolves — the nav profile link becomes real. */
    hydration: {
      p50: 900,
      p95: 4_200,
      p99: 8_000,
      src: 'livetest goto→hydrated timings, 2026-08',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** Follow/unfollow MUTATION response arrival (ADR 0304: "~1–2 s"). */
    mutation: {
      p50: 1_100,
      p99: 8_000,
      src: 'ADR 0304 arbitration timings; livetest mutation captures',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** Full navigation (`webContents.loadURL` resolve). */
    nav: {
      p50: 1_200,
      p99: 20_000,
      src: 'livetest navigation timings on a cold profile page',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** A dialog / confirm control appearing after a click. */
    control: {
      p50: 600,
      p99: 5_300,
      src: 'livetest dialog-appearance timings',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** `executeJavaScript` round trip on a live page. */
    evaluate: {
      p50: 400,
      p99: 10_000,
      src: 'livetest in-page script timings (sub-second when the page is alive)',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** CDP `Network.getResponseBody` — a resource-cache read. */
    resourceRead: {
      p50: 200,
      p99: 6_600,
      src: 'livetest getBody timings (normally instant, occasionally re-fetched)',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** The in-page envelope fetch (`envelopeFetchScript`). */
    fetchEnvelope: {
      p50: 700,
      p99: 13_300,
      src: 'livetest envelope-fetch timings on the graph endpoints',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** The notifications/news-inbox drawer fetch after the bell click. */
    notifications: {
      p50: 900,
      p99: 6_600,
      src: 'livetest follow-back watcher captures',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** A follow-request Confirm click consuming its row. */
    acceptRow: {
      p50: 800,
      p99: 2_650,
      src: 'livetest accept-verify timings',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
    /** The connectivity probe (a cheap 204 endpoint). */
    probe: {
      p50: 180,
      p99: 3_300,
      src: 'net.request 204-probe timings across home/mobile links',
      rev: '2026-09',
    } satisfies LatencyOpSeed,
  },
  /** P(a single click fails for ORDINARY, non-systemic reasons). */
  ORDINARY_FAIL_RATE: {
    value: 0.3,
    src: 'engine ledger: unverified/failed rate during healthy windows',
    rev: '2026-09',
  },
  /** P(a single action is reported blocked for ordinary reasons). */
  ORDINARY_BLOCK_RATE: {
    value: 0.1,
    src: 'engine ledger: blocked-outcome rate during healthy windows',
    rev: '2026-09',
  },
  /** P(a definitive shape/drift signal fires without real drift) — a false positive. */
  ORDINARY_DRIFT_SIGNAL_RATE: {
    value: 0.02,
    src: 'SHAPE_MISMATCH rate on healthy responses (ADR 0303 telemetry)',
    rev: '2026-09',
  },
  /** P(a fetched list page legitimately carries zero new pks — a duplicate window). */
  ORDINARY_DUPLICATE_PAGE_RATE: {
    value: 0.1,
    src: 'prune census walks: duplicate-window rate on healthy paginated reads',
    rev: '2026-09',
  },
  /** Display/perception constants — the renderer's own physics. */
  DISPLAY: {
    /** One 60 Hz frame. */
    frameMs: 16.7,
    /** The perceptual "instant" threshold. */
    perceptionMs: 100,
    src: 'Card 1991 / Nielsen 1993 response-time limits; 60 Hz frame budget',
    rev: '2026-09',
  },
} as const;

/** Every `{ src, rev }` pair in {@link EMPIRICAL}, flattened for the freshness test. */
export function empiricalProvenance(): ReadonlyArray<{ path: string } & Provenance> {
  const out: Array<{ path: string } & Provenance> = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.src === 'string' && typeof rec.rev === 'string') {
      out.push({ path, src: rec.src, rev: rec.rev });
      return;
    }
    for (const [k, v] of Object.entries(rec)) walk(v, path === '' ? k : `${path}.${k}`);
  };
  walk(EMPIRICAL, '');
  return out;
}
