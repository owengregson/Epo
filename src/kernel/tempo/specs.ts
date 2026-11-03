/**
 * The tempo-spec registry (ADR 0607, spec §5.11): for every tempo key, the axis
 * it scales on, its prior (the value at tempo 1 — today's value), the floor it
 * never crosses, and the registry or MOTION keys its prior reproduces. Outside
 * `src/kernel/tempo` no code reads a claimed prior: it asks a `TempoSource`.
 */

import type { LatencyOp } from '../derive';
import { ENGINE, NOISE, PRUNE, RECOVERY, RIM, SESSION } from '../derive';
import { MOTION } from '../motion-policy';
import { PACING_BASE_MS, POLICY } from '../policy';
import { MIN_SCROLL_STEP_PX } from '../tempo-policy';
import type { TempoAxis, TempoKey } from './keys';

export type Prior =
  | { readonly shape: 'band'; readonly min: number; readonly max: number }
  | { readonly shape: 'logn'; readonly median: number; readonly sigma: number; readonly min: number; readonly max: number }
  /** With probability `p` the `alt` draw (this key's own band) replaces the `base` draw. */
  | { readonly shape: 'mix'; readonly p: number; readonly base: Prior; readonly alt: Prior }
  /** Viewports per scroll burst; the px floor applies at the call site. */
  | { readonly shape: 'scale'; readonly value: number; readonly spread: number }
  | { readonly shape: 'base'; readonly value: number }
  | { readonly shape: 'pages'; readonly min: number; readonly max: number }
  /** [lo, hi] × the call site's own D4 base (`TempoSite.baseMs`). */
  | { readonly shape: 'relative'; readonly lo: number; readonly hi: number }
  /** The Fitts travel terms of MOTION, stretched per gesture by `deriveMotion`. */
  | { readonly shape: 'travel' }
  /** The session's `GapSpec`, drawn by the plan's gap model. */
  | { readonly shape: 'gap' };

export type Floor =
  | { readonly kind: 'latency'; readonly op: Extract<LatencyOp, 'hydration' | 'notifications' | 'fetchEnvelope' | 'acceptRow' | 'probe'> }
  | { readonly kind: 'display' }
  | { readonly kind: 'prior-min' }
  /** Another key's prior minimum: a rest never shortens below the briskest page wait. */
  | { readonly kind: 'prior-min-of'; readonly key: TempoKey }
  | { readonly kind: 'equals-prior' }
  /** The call site's own D4 poll interval (`TempoSite.pollMs`). */
  | { readonly kind: 'poll' }
  | { readonly kind: 'boundary' }
  | { readonly kind: 'px'; readonly px: number }
  | { readonly kind: 'pages'; readonly pages: number }
  | { readonly kind: 'caution-floor' };

/** What a prior reproduces: registry keys, MOTION keys, a moved literal, or nothing yet (an added key). */
export type Identity =
  | { readonly registry: readonly string[] }
  | { readonly motion: readonly (keyof typeof MOTION)[] }
  | { readonly moved: string }
  | { readonly added: '0607'; readonly from: string };

export interface TempoSpec {
  readonly axis: TempoAxis;
  readonly prior: Prior;
  readonly floor: Floor;
  readonly identity: Identity;
}

const band = (min: number, max: number): Prior => ({ shape: 'band', min, max });
const pair = (p: readonly [number, number]): Prior => band(p[0], p[1]);
const logn = (median: number, sigma: number, p: readonly [number, number]): Prior =>
  ({ shape: 'logn', median, sigma, min: p[0], max: p[1] });
const base = (value: number): Prior => ({ shape: 'base', value });

/** The registry's uniform-band rule (`derive.ts`): base × (1 ± BAND_HALF_WIDTH) on a 50 ms grid. */
const BAND_GRID_MS = 50;
const onGrid = (n: number): number =>
  Number.parseFloat((Math.round(n / BAND_GRID_MS) * BAND_GRID_MS).toPrecision(12));
const READ_BAND = band(onGrid(PACING_BASE_MS.read * (1 - POLICY.BAND_HALF_WIDTH)),
  onGrid(PACING_BASE_MS.read * (1 + POLICY.BAND_HALF_WIDTH)));
const CLOSE_BAND = band(RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS, RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS);
const PRIOR_MIN = { kind: 'prior-min' } as const;
const SAME = { kind: 'equals-prior' } as const;

export const TEMPO_SPECS = {
  'gap.action': { axis: 'pace', prior: { shape: 'gap' }, floor: { kind: 'caution-floor' },
    identity: { registry: ['SESSION.GAP_SIGMA', 'SESSION.GAP_CAP_MS', 'SESSION.HAWKES_ALPHA', 'SESSION.HAWKES_TAU_MS'] } },
  'gap.accept': { axis: 'pace', prior: band(RIM.ACCEPT_PACE_MIN_MS, RIM.ACCEPT_PACE_MAX_MS),
    floor: { kind: 'latency', op: 'acceptRow' }, identity: { registry: ['RIM.ACCEPT_PACE_MIN_MS', 'RIM.ACCEPT_PACE_MAX_MS'] } },
  'dwell.visit': { axis: 'pace', prior: logn(MOTION.profileDwellMedianMs, MOTION.profileDwellSigma, MOTION.profileDwellMs),
    floor: PRIOR_MIN, identity: { motion: ['profileDwellMedianMs', 'profileDwellSigma', 'profileDwellMs'] } },
  'dwell.before-press': { axis: 'pace', prior: READ_BAND, floor: PRIOR_MIN,
    identity: { added: '0607', from: 'band(PACING_BASE_MS.read)' } },
  'ui.step-pause': { axis: 'pace', prior: CLOSE_BAND, floor: { kind: 'display' },
    identity: { added: '0607', from: 'RIM.NOTIFICATIONS_CLOSE_DELAY_*' } },
  'drawer.close-settle': { axis: 'pace', prior: CLOSE_BAND, floor: { kind: 'display' },
    identity: { registry: ['RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS', 'RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS'] } },
  'scroll.wait.drawer': { axis: 'pace', prior: band(RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS, RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS),
    floor: { kind: 'latency', op: 'notifications' },
    identity: { registry: ['RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS', 'RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS'] } },
  'scroll.wait.dialog': { axis: 'pace',
    prior: band(RIM.SCROLL_WAIT_MS * NOISE.BEAT_MIN_FACTOR, RIM.SCROLL_WAIT_MS * NOISE.BEAT_MAX_FACTOR),
    floor: { kind: 'latency', op: 'hydration' }, identity: { registry: ['RIM.SCROLL_WAIT_MS'] } },
  'scroll.wait.acquire': { axis: 'pace', prior: band(RIM.ACQUIRE_SCROLL_MIN_MS, RIM.ACQUIRE_SCROLL_MAX_MS),
    floor: { kind: 'latency', op: 'hydration' }, identity: { registry: ['RIM.ACQUIRE_SCROLL_MIN_MS', 'RIM.ACQUIRE_SCROLL_MAX_MS'] } },
  'scroll.depth.drawer': { axis: 'depth', prior: { shape: 'scale', value: 2, spread: 0 },
    floor: { kind: 'px', px: MIN_SCROLL_STEP_PX }, identity: { moved: 'actor-scroll.ts drawer step clientHeight × 2' } },
  'scroll.depth.dialog': { axis: 'depth', prior: { shape: 'scale', value: 3, spread: 0 },
    floor: { kind: 'px', px: MIN_SCROLL_STEP_PX }, identity: { moved: 'actor-scroll.ts dialog step clientHeight × 3' } },
  'walk.page': { axis: 'pace', prior: band(RIM.LIST_WALK_PAGE_MIN_MS, RIM.LIST_WALK_PAGE_MAX_MS),
    floor: { kind: 'latency', op: 'fetchEnvelope' }, identity: { registry: ['RIM.LIST_WALK_PAGE_MIN_MS', 'RIM.LIST_WALK_PAGE_MAX_MS'] } },
  'walk.rest': { axis: 'pace', prior: band(RIM.LIST_WALK_REST_MIN_MS, RIM.LIST_WALK_REST_MAX_MS),
    floor: { kind: 'prior-min-of', key: 'walk.page' }, identity: { registry: ['RIM.LIST_WALK_REST_MIN_MS', 'RIM.LIST_WALK_REST_MAX_MS'] } },
  'walk.rest-every': { axis: 'depth',
    prior: { shape: 'pages', min: NOISE.LIST_WALK_REST_EVERY_MIN, max: NOISE.LIST_WALK_REST_EVERY_MAX },
    floor: { kind: 'pages', pages: 1 }, identity: { registry: ['NOISE.LIST_WALK_REST_EVERY_MIN', 'NOISE.LIST_WALK_REST_EVERY_MAX'] } },
  'pause.retry': { axis: 'pace', prior: { shape: 'relative', lo: NOISE.BEAT_MIN_FACTOR, hi: NOISE.BEAT_MAX_FACTOR },
    floor: { kind: 'poll' }, identity: { registry: ['NOISE.BEAT_MIN_FACTOR', 'NOISE.BEAT_MAX_FACTOR'] } },
  'pause.wake-settle': { axis: 'pace', prior: band(RECOVERY.RESUME_SETTLE_MIN_MS, RECOVERY.RESUME_SETTLE_MAX_MS),
    floor: { kind: 'latency', op: 'probe' }, identity: { registry: ['RECOVERY.RESUME_SETTLE_MIN_MS', 'RECOVERY.RESUME_SETTLE_MAX_MS'] } },
  'pause.after-task': { axis: 'pace', prior: band(ENGINE.REFILL_PACING_MIN_MS, ENGINE.REFILL_PACING_MAX_MS),
    floor: PRIOR_MIN, identity: { registry: ['ENGINE.REFILL_PACING_MIN_MS', 'ENGINE.REFILL_PACING_MAX_MS'] } },
  'park.blocked': { axis: 'pace-up', prior: base(PRUNE.PARK_MS), floor: SAME, identity: { registry: ['PRUNE.PARK_MS'] } },
  'backoff.walled': { axis: 'pace-up', prior: base(ENGINE.ENRICH_BACKOFF_MS), floor: SAME,
    identity: { registry: ['ENGINE.ENRICH_BACKOFF_MS'] } },
  'beat.transient': { axis: 'pace-up', prior: base(ENGINE.IDLE_MS), floor: SAME, identity: { registry: ['ENGINE.IDLE_MS'] } },
  'check.spacing': { axis: 'pace', prior: base(2 * SESSION.SESSION_BOUNDARY_MS), floor: { kind: 'boundary' },
    identity: { moved: 'Settings followbackSweepHours default (1 h)' } },
  'motion.travel': { axis: 'motion', prior: { shape: 'travel' }, floor: PRIOR_MIN,
    identity: { motion: ['travelBaseMs', 'travelScaleMs', 'moveMinMs', 'moveMaxMs'] } },
  'motion.press': { axis: 'motion', prior: logn(MOTION.pressMedianMs, MOTION.pressSigma, MOTION.pressMs), floor: PRIOR_MIN,
    identity: { motion: ['pressMs', 'pressMedianMs', 'pressSigma'] } },
  'motion.pre-press': { axis: 'motion', prior: pair(MOTION.prePressMs), floor: PRIOR_MIN, identity: { motion: ['prePressMs'] } },
  'motion.hover-settle': { axis: 'motion', prior: pair(MOTION.hoverSettleMs), floor: PRIOR_MIN,
    identity: { motion: ['hoverSettleMs'] } },
  'wheel.tick-pause': { axis: 'motion', prior: pair(MOTION.wheelPauseMs), floor: PRIOR_MIN, identity: { motion: ['wheelPauseMs'] } },
  'wheel.micro-pause': { axis: 'motion',
    prior: { shape: 'mix', p: MOTION.wheelMicroPauseProbability, base: pair(MOTION.wheelPauseMs), alt: pair(MOTION.wheelMicroPauseMs) },
    floor: PRIOR_MIN, identity: { motion: ['wheelMicroPauseProbability', 'wheelMicroPauseMs'] } },
  'wheel.correction-pause': { axis: 'motion', prior: pair(MOTION.wheelCorrectionPauseMs), floor: PRIOR_MIN,
    identity: { motion: ['wheelCorrectionPauseMs'] } },
} as const satisfies { readonly [K in TempoKey]: TempoSpec };
