/**
 * Static-timing fixture: reads of tempo-claimed priors, however they are reached. Nothing imports
 * it; tests/tooling/no-static-timing.test.ts scans it and pins every key.
 */
import { MOTION } from '@/kernel/motion-policy';
import { PACING_BASE_MS } from '@/kernel/policy';
import * as timing from '@/timing/config';
import { ENGINE as ENGINE_TIMING, NOISE, RIM } from '@/timing/config';

export const scrollWait = RIM.SCROLL_WAIT_MS;
export const idle = ENGINE_TIMING.IDLE_MS;
export const park = timing.PRUNE.PARK_MS;
export const { BEAT_MIN_FACTOR } = NOISE;
export const gravity = MOTION.gravity;
export const readBase = PACING_BASE_MS.read;

// Not claimed by any tempo spec: a runaway bound stays readable.
export const walkPages = RIM.LIST_WALK_MAX_PAGES;

// A local alias, a dynamic key, and the group handed over whole: each still reads a prior.
const WALK = RIM;
export const viaAlias = WALK.LIST_WALK_REST_MIN_MS;
export const viaKey = (key: 'SCROLL_WAIT_MS'): number => RIM[key];
export const handedOver = Object.keys(NOISE);
export const copied = { ...ENGINE_TIMING };
