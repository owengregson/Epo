/**
 * Phase F's moved numbers keep today's values (F2a step 10): the input probe is
 * derived from the display frame, the census guards moved into the kernel, and
 * the exploration literals their consumers will switch to are declared.
 */

import { ACQUIRE_SKIP_POOL_FACTOR, MAX_ENRICH_PASSES_PER_CYCLE } from '@/engine/target-pipeline';
import { CENSUS_POLICY } from '@/kernel/census-policy';
import { RIM } from '@/kernel/derive';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { INPUT_PROBE } from '@/kernel/input-probe';
import { ACQUISITION_DEFAULTS } from '@/rim/follower-acquisition';
import { INPUT_PROBE as CONFIG_INPUT_PROBE } from '@/timing/config';

test('the input probe is today\'s 10 polls 50 ms apart, the interval three display frames', () => {
  expect(INPUT_PROBE).toEqual({ ROUNDS: 10, INTERVAL_MS: 50 });
  expect(Math.abs(INPUT_PROBE.INTERVAL_MS - 3 * EMPIRICAL.DISPLAY.frameMs)).toBeLessThan(25);
  expect(CONFIG_INPUT_PROBE).toBe(INPUT_PROBE);
});

test('the census policy holds the moved scan guards and the walk bound of five runaway bounds', () => {
  expect(CENSUS_POLICY).toEqual({ coverageFloor: 50, scanCoverageMin: 0.85, maxWalkPages: 1_000 });
  expect(CENSUS_POLICY.maxWalkPages).toBe(5 * RIM.LIST_WALK_MAX_PAGES);
});

test('the new exploration entries equal the literals they will replace', () => {
  expect(EXPLORATION_POLICY.skipPoolFactor).toBe(ACQUIRE_SKIP_POOL_FACTOR);
  expect(EXPLORATION_POLICY.maxEnrichPassesPerCycle).toBe(MAX_ENRICH_PASSES_PER_CYCLE);
  expect(EXPLORATION_POLICY.maxCoverageFraction).toBe(ACQUISITION_DEFAULTS.maxCoverageFraction);
  expect(EXPLORATION_POLICY).toMatchObject({
    ownFollowersPickMax: 15, rankMinCandidates: 2, unknownOverlap: 0.5, overlapWeight: 0.5, sharePenalty: 0.1,
    shareMinSources: 3, refillBelowLiveSources: 3, maxDiscovered: 5,
  });
});
