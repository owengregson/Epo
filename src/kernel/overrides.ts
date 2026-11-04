/**
 * Tier 2 escape hatch — values that do NOT fall out of the fundamentals.
 *
 * There is no tolerance in this system: a derived constant either equals what
 * the app ships or it is named here, with the formula's answer alongside the
 * shipped one and a reason. That makes the residue countable and arguable
 * instead of invisible.
 *
 * Discipline:
 * - An override pins a value; it never introduces a new one. Adding an entry
 *   requires the golden test (`tests/kernel/derive-golden.test.ts`) to still pass.
 * - `derived` records what the formula produces TODAY, so an override silently
 *   drifting away from its derivation is caught by a test, not by a reader.
 * - `change: true` marks the one place we deliberately took the derivation's
 *   answer over the shipped one. Exactly one entry carries it.
 *
 * Layering: `src/kernel/**` imports NOTHING from the rest of `src/`.
 *
 * See docs/adr/0606-derivation-findings.md.
 */

/** One value the derivation does not reproduce, and why we keep the shipped one. */
export interface Override {
  /** The value the app actually uses. */
  readonly value: number;
  /** What `derive.ts` computes for this key, for the diff a reader wants. */
  readonly derived: number;
  /** Why the derived value is not used. */
  readonly reason: string;
  /** Set only where we took the DERIVED value over the shipped one. */
  readonly change?: true;
}

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * The complete residue, keyed by `GROUP.KEY` (`GROUP.KEY.index` for an array
 * element, `TABLE.level.field` for the pattern-map tables). Everything not
 * listed here derives exactly.
 *
 * Three families:
 *   1. UNIFORM PACING BANDS — the band SHAPE derives (`base × (1 ± 0.286)`), but
 *      the seven bands pinned here were hand-widened. 14 of the 19 entries.
 *   2. NUMBERS THE DERIVATION GENUINELY DISAGREES WITH — the bold gap floor,
 *      ladder rung 3, the identity retry spacing, and a cleanup run's failure
 *      halt (read by `derive.ts` `pruneFailingThreshold`). The Cautious floor
 *      takes its derived 70 s (owner Q11; `registry-changes.ts` CHANGED).
 *   3. ONE DELIBERATE CHANGE — the prune cool-down, raised to the derived value.
 */
export const OVERRIDES: Readonly<Record<string, Override>> = {
  // --- 1. Uniform pacing bands the shipped code widened by hand ---------------
  'RIM.ACQUIRE_SCROLL_MIN_MS': {
    value: 1_400,
    derived: 1_800,
    reason:
      'Dialog-fallback scroll band, widened to ±44% by hand: this is the one bound-less growth path, so its pacing was deliberately made the least predictable.',
  },
  'RIM.ACQUIRE_SCROLL_MAX_MS': {
    value: 3_600,
    derived: 3_200,
    reason: 'Upper edge of the same hand-widened band.',
  },
  'RIM.LIST_WALK_PAGE_MIN_MS': {
    value: 1 * SEC,
    derived: 1_450,
    reason:
      'Direct list-page walk pacing, widened to ±50%: 50-row pages carry four times a dialog page, and the census wants to finish, so the band was stretched at both ends rather than scaled.',
  },
  'RIM.LIST_WALK_PAGE_MAX_MS': {
    value: 3 * SEC,
    derived: 2_550,
    reason: 'Upper edge of the same hand-widened band.',
  },
  'RIM.LIST_WALK_REST_MIN_MS': {
    value: 5 * SEC,
    derived: 7_150,
    reason:
      'Anti-throttle breather between page bursts, widened to ±50%: the rest must never itself become a recognisable period, so it spans a 3× range.',
  },
  'RIM.LIST_WALK_REST_MAX_MS': {
    value: 15 * SEC,
    derived: 12_850,
    reason: 'Upper edge of the same hand-widened band.',
  },
  'RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS': {
    value: 500,
    derived: 600,
    reason:
      'Drawer-close settle, widened to ±41%: sized to "a beat", not to a measured latency — the drawer has already been read by the time it closes.',
  },
  'RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS': {
    value: 1_200,
    derived: 1_100,
    reason: 'Upper edge of the same hand-widened band.',
  },
  'RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS': {
    value: 1_400,
    derived: 1_500,
    reason:
      'Post-scroll wait for an older feed page, widened to ±33%. The midpoint tracks the notifications p50; the width is hand-set.',
  },
  'RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS': {
    value: 2_800,
    derived: 2_700,
    reason: 'Upper edge of the same hand-widened band.',
  },
  'RIM.ACCEPT_PACE_MIN_MS': {
    value: 1_500,
    derived: 1_600,
    reason:
      'Pause between Confirm clicks, widened to ±33%. The midpoint tracks the accept-row p50 × 2.8; the width is hand-set.',
  },
  'RIM.ACCEPT_PACE_MAX_MS': {
    value: 3 * SEC,
    derived: 2_900,
    reason: 'Upper edge of the same hand-widened band.',
  },
  'RECOVERY.RESUME_SETTLE_MIN_MS': {
    value: 3 * SEC,
    derived: 4_650,
    reason:
      'Post-wake settle band, widened to ±54%: how long a network stack takes to come back after a lid-open is not something the app measures, and the band is deliberately wide so post-wake work never lands at a fixed offset.',
  },
  'RECOVERY.RESUME_SETTLE_MAX_MS': {
    value: 10 * SEC,
    derived: 8_350,
    reason: 'Upper edge of the same hand-widened band.',
  },

  // --- 2. Numbers the derivation genuinely disagrees with ----------------------
  'ADAPTER.IDENTITY_RETRY_MS': {
    value: 1_200,
    derived: 1_500,
    reason:
      'Retry spacing inside a 4-attempt identity ladder. The attempts × wait PRODUCT (4.8 s) is the real budget; the split between them is a startup-latency choice, not a measured quantile.',
  },
  'CAUTION.bold.floorSeconds': {
    value: 35,
    derived: 33,
    reason:
      'Today is 2 s MORE conservative than the burst tolerance requires at cap 30. Harmless; pinned so the golden diff stays empty.',
  },
  'RECOVERY.HOLD_MEDIANS_MS.2': {
    value: 120 * MIN,
    derived: 135 * MIN,
    reason:
      'Ladder rung 3. The geometric law (W_p50 × 0.33 × 1.5^(n-1)) gives 2.25 h; the shipped ladder flattens the last rung to 2 h. Rungs 1 and 2 derive exactly, and the coverage requirement (Σ ≥ p50 = 3 h) is met either way. Pinned for wave A.',
  },
  'PRUNE.CONSECUTIVE_FAIL_HALT': {
    value: 4,
    derived: 7,
    reason:
      "A cleanup run's consecutive failed unfollows before it halts. The cold breaker posterior says 7; a bulk run halts sooner than the growth loop so a broken unfollow path cannot burn the candidate list.",
  },

  // --- 3. The one deliberate behaviour change ---------------------------------
  'RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS': {
    value: 3 * HOUR,
    derived: 3 * HOUR,
    reason:
      'BEHAVIOUR CHANGE (toward safety). The shipped value was 2 h — SHORTER than the p50 soft wall (3 h) it exists to sit out, so a scheduled prune could walk a census straight back into the same wall and deepen the block. Raised to the derived p50. The only key in the registry whose value moves in this wave.',
    change: true,
  },
};

/** The shipped value for `path`, or `fallback` when nothing overrides it. */
export function overridden(path: string, fallback: number): number {
  return OVERRIDES[path]?.value ?? fallback;
}

/** Every override, with its path: each one applies to the value it names. */
export function appliedOverrides(): ReadonlyArray<{ path: string } & Override> {
  return Object.entries(OVERRIDES).map(([path, o]) => ({ path, ...o }));
}
