/**
 * The plan mix's pure pieces (spec §5.7): the cleanup cool-down after a rate wall, and the mix over a
 * view whose admission and shares a test sets (the engine suite drives it through the loop).
 */
import { cleanupCooldown, planMix } from '@/engine/plan-mix';
import type { FollowRecord } from '@/store/types';
import { RECOVERY } from '@/timing/config';
import { stubPlanView } from '../kit/harness-plan';

const T0 = Date.parse('2026-08-12T12:00:00');
const quiet = { phase: 'inactive', kindTally: {} };

describe('the cleanup cool-down', () => {
  test("a rate-limit halt holds cleanup for the override's window, other halts do not", () => {
    const halt = { reason: 'rate-limited', at: T0 };
    expect(cleanupCooldown({ lastHalt: halt, ladder: quiet }, T0 + RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS - 1)).toBe(true);
    expect(cleanupCooldown({ lastHalt: halt, ladder: quiet }, T0 + RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS)).toBe(false);
    expect(cleanupCooldown({ lastHalt: { reason: 'chain-exhausted', at: T0 }, ladder: quiet }, T0 + 1)).toBe(false);
  });

  test('a live ladder that classified a rate-limited failure holds cleanup', () => {
    expect(cleanupCooldown({ lastHalt: null, ladder: { phase: 'holding', kindTally: { 'rate-limited': 1 } } }, T0)).toBe(true);
    expect(cleanupCooldown({ lastHalt: null, ladder: { phase: 'probing', kindTally: { drift: 2 } } }, T0)).toBe(false);
  });
});

describe('the mix', () => {
  const follow = { accountPk: 'f', state: 'queued' } as FollowRecord;
  const unfollow = { accountPk: 'u', state: 'unfollow_queued' } as FollowRecord;
  const churn = { nextDue: (_now: number, kind?: 'follow' | 'unfollow') => (kind === 'unfollow' ? unfollow : follow) };
  const woven = () => ({ pk: 'w', username: 'woven' });
  const inputs = (o: Parameters<typeof stubPlanView>[1], extra: { paused?: boolean; cooldown?: boolean } = {}) => ({
    view: stubPlanView(T0, o), churn, woven, unfollowsPaused: extra.paused ?? false, cooldown: extra.cooldown ?? false,
  });

  test('between sessions there is nothing to act on', () => {
    expect(planMix(inputs({ open: false, nextSessionAt: T0 + 1, target: 25 }), T0)).toMatchObject({ due: null, pruneCandidate: null });
  });

  test('a due lifecycle unfollow comes first among unfollows; woven cleanup only when none is due', () => {
    expect(planMix(inputs({ open: true, nextSessionAt: null, target: 25 }), T0).due).toBe(unfollow);
    const none = { nextDue: (_now: number, kind?: 'follow' | 'unfollow') => (kind === 'unfollow' ? null : follow) };
    expect(planMix({ ...inputs({ open: true, nextSessionAt: null, target: 25 }), churn: none }, T0).pruneCandidate).toEqual(woven());
    expect(planMix({ ...inputs({ open: true, nextSessionAt: null, target: 25 }, { cooldown: true }), churn: none }, T0).due).toBe(follow);
  });

  test('the draw against the unfollow share chooses the kind; an unfollow never takes a follow budget', () => {
    expect(planMix(inputs({ open: true, nextSessionAt: null, target: 25, mixDraw: 0.2 }), T0).due).toBe(unfollow);
    expect(planMix(inputs({ open: true, nextSessionAt: null, target: 25, mixDraw: 0.8 }), T0).due).toBe(follow);
    expect(planMix(inputs({ open: true, nextSessionAt: null, target: 25, unfollowsLeft: 0 }), T0).due).toBe(follow);
    expect(planMix(inputs({ open: true, nextSessionAt: null, target: 25 }, { paused: true }), T0).due).toBe(follow);
  });

  test('a spent day refuses both kinds', () => {
    expect(planMix(inputs({ open: true, nextSessionAt: null, target: 5, usedAuto: 5 }), T0)).toMatchObject({ due: null, pruneCandidate: null });
  });
});
