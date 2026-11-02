/**
 * The rule table IS the loop's contract, so it is asserted directly — and the
 * PRECEDENCE is proved as a property over generated facts rather than as a
 * hand-written ordering assertion (ADR 0902). `engine.test.ts` drives the same
 * table end to end against a real Engine.
 */

import fc from 'fast-check';

import type {
  ActionFacts,
  CadenceFacts,
  Facts,
  LedgerFacts,
  Mode,
  PacingFacts,
  PruneFacts,
  QueueFacts,
  RecoveryFacts,
  RunCtx,
  StreakFacts,
} from '@/engine/facts';
import {
  ALL_MODES,
  decideProgram,
  factsNeededFor,
  PROGRAM,
  programFor,
  type Rule,
  type RuleVerdict,
} from '@/engine/rules';
import type { FollowRecord } from '@/store/types';

const GROWTH_ORDER = [
  'aborted',
  'sentinel-auth',
  'recovery-hold',
  'sentinel-blocked',
  'reconcile',
  'pacing',
  'target',
  'followback',
  'rotate',
  'refill',
  'action',
  'chain',
  'idle',
];

// --- Arbitraries -------------------------------------------------------------------

const rec = (state: FollowRecord['state']): FollowRecord => ({
  accountPk: 'a1',
  targetPk: 't1',
  state,
  retryCount: 0,
});

const arbLedger: fc.Arbitrary<LedgerFacts> = fc.record({
  atHardCeiling: fc.boolean(),
  atOperatingRate: fc.boolean(),
  withinActiveHours: fc.boolean(),
  msUntilCycleReset: fc.integer({ min: 0, max: 86_400_000 }),
  actionsInLastHour: fc.integer({ min: 0, max: 200 }),
});

const arbPacing: fc.Arbitrary<PacingFacts> = fc.record({
  model: fc.constantFrom<'organic' | 'legacy'>('organic', 'legacy'),
  sessionOpen: fc.boolean(),
  nextSessionStartAt: fc.integer({ min: 0, max: 2_000_000_000 }),
  hourlyVelocityCap: fc.integer({ min: 0, max: 60 }),
  activeHoursStart: fc.integer({ min: 0, max: 23 }),
});

const arbQueue: fc.Arbitrary<QueueFacts> = fc.record({
  queuedForTarget: fc.integer({ min: 0, max: 500 }),
  lowWaterCandidates: fc.integer({ min: 0, max: 500 }),
  targetExhausted: fc.boolean(),
});

const arbCadence: fc.Arbitrary<CadenceFacts> = fc.record({
  sweepDue: fc.boolean(),
  overdue: fc.constant([]),
});

const arbAction: fc.Arbitrary<ActionFacts> = fc.record({
  due: fc.option(fc.constantFrom(rec('queued'), rec('unfollow_queued')), { nil: null }),
  pruneCandidate: fc.option(fc.constant({ pk: 'p1', username: 'pruneme' }), { nil: null }),
  weaveDraw: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  unfollowFraction: fc.double({ min: 0, max: 1, noNaN: true }),
});

const arbRecovery: fc.Arbitrary<RecoveryFacts> = fc.record({
  phase: fc.constantFrom('inactive', 'diagnosing', 'holding', 'probing', 'exhausted'),
  holdRemainingMs: fc.integer({ min: 0, max: 10_800_000 }),
});

const arbStreaks: fc.Arbitrary<StreakFacts> = fc.record({
  failed: fc.integer({ min: 0, max: 20 }),
  drift: fc.integer({ min: 0, max: 20 }),
  blocked: fc.integer({ min: 0, max: 20 }),
  lastBlockedCause: fc.constantFrom(null, 'rate-limited' as const, 'tab-unhealthy' as const),
  failingEntryThreshold: fc.integer({ min: 1, max: 12 }),
});

const arbPrune: fc.Arbitrary<PruneFacts> = fc.record({
  candidate: fc.option(
    fc.record({ pk: fc.constant('c1'), username: fc.option(fc.constant('cand'), { nil: null }) }),
    { nil: null },
  ),
  followsUsNow: fc.boolean(),
  whitelist: fc.constantFrom<readonly string[]>([], ['cand']),
  atDailyCap: fc.boolean(),
});

const arbFacts: fc.Arbitrary<Facts> = fc.record({
  lifecycle: fc.record({ aborted: fc.boolean(), halted: fc.boolean() }),
  clock: fc.record({ now: fc.integer({ min: 0, max: 2_000_000_000 }) }),
  sentinel: fc.record({
    status: fc.constantFrom('ok', 'challenge', 'logged-out', 'action-blocked'),
  }),
  recovery: arbRecovery,
  ledger: arbLedger,
  pacing: arbPacing,
  target: fc.record({
    current: fc.option(fc.constant({ pk: 't1', username: 'targetone' }), { nil: null }),
  }),
  queue: arbQueue,
  cadence: arbCadence,
  action: arbAction,
  streaks: arbStreaks,
  prune: arbPrune,
});

/**
 * Decide with a Facts object that THROWS on any key the rule did not declare —
 * so "the kernel gathers exactly `needs`, once" is enforced, not documented.
 */
const strict = (facts: Facts, needs: readonly string[]): Facts =>
  new Proxy(facts, {
    get(target, key) {
      // `await` probes `.then`; symbols are engine plumbing, never facts.
      if (typeof key === 'symbol' || key === 'then') return undefined;
      if (!needs.includes(key)) {
        throw new Error(`rule read an undeclared fact: '${key}' (needs: ${needs.join(',')})`);
      }
      return target[key as keyof Facts];
    },
  });

const decide = (facts: Facts, mode: Mode = 'growth'): Promise<{ rule: string; verdict: RuleVerdict } | null> =>
  decideProgram({ mode }, (needs) => Promise.resolve(strict(facts, needs)));

/**
 * A claim as a comparable value: a park's delay may be a freshly-built
 * `DelayPolicy` closure, so compare its shape (kind), not its identity.
 */
const normalize = (claim: { rule: string; verdict: RuleVerdict } | null): unknown => {
  if (claim === null) return null;
  const { verdict } = claim;
  if (verdict.do !== 'park') return claim;
  const { delay } = verdict.spec;
  return {
    rule: claim.rule,
    verdict: {
      do: 'park',
      spec: { ...verdict.spec, delay: typeof delay === 'number' ? delay : delay.kind },
    },
  };
};

/** Every verdict each rule would independently produce for the same facts. */
const allVerdicts = (rules: readonly Rule[], facts: Facts, run: RunCtx): RuleVerdict[] =>
  rules.map((r) => r.decide(facts, run)).filter((v): v is RuleVerdict => v !== null);

// --- The table ---------------------------------------------------------------------

describe('the rule table', () => {
  test('declares the growth loop precedence, in order', () => {
    expect(programFor('growth').map((r) => r.id)).toEqual(GROWTH_ORDER);
  });

  test('every mode runs the safety prefix first', () => {
    const safety = PROGRAM.safety.map((r) => r.id);
    for (const mode of ALL_MODES) {
      expect(programFor(mode).slice(0, safety.length).map((r) => r.id)).toEqual(safety);
    }
  });

  test('prune is a MODE over the same safety prefix, not a second engine', () => {
    expect(programFor('prune-run').map((r) => r.id)).toEqual([
      ...PROGRAM.safety.map((r) => r.id),
      'prune-cap',
      'prune-candidate',
    ]);
    // No growth rule leaks into a prune mode, and vice versa.
    for (const rule of PROGRAM.growth) expect(rule.modes).toEqual(['growth']);
  });

  test('every rule declares at least one mode, and only known fact groups', () => {
    const known = new Set<string>([
      'lifecycle',
      'clock',
      'sentinel',
      'recovery',
      'ledger',
      'pacing',
      'target',
      'queue',
      'cadence',
      'action',
      'streaks',
      'prune',
    ]);
    for (const mode of ALL_MODES) {
      for (const rule of programFor(mode)) {
        expect(rule.modes.length).toBeGreaterThan(0);
        for (const need of rule.needs) expect(known.has(need)).toBe(true);
      }
    }
  });

  test('factsNeededFor names exactly the groups a mode can read', () => {
    const growth = new Set(factsNeededFor('growth'));
    expect(growth).toContain('lifecycle');
    expect(growth).toContain('sentinel');
    expect(growth).toContain('action');
    // Prune facts are never gathered in growth mode.
    expect(growth.has('prune')).toBe(false);
  });
});

// --- Precedence, as properties -----------------------------------------------------

describe('the precedence property', () => {
  test('EXACTLY ONE verdict for any facts, and no rule reads an undeclared fact', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, async (facts) => {
        const claim = await decide(facts);
        expect(claim).not.toBeNull();
        expect(GROWTH_ORDER).toContain((claim as { rule: string }).rule);
      }),
      { numRuns: 400 },
    );
  });

  test('deciding is PURE: the same facts always yield the same verdict', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, async (facts) => {
        expect(normalize(await decide(facts))).toEqual(normalize(await decide(facts)));
      }),
      { numRuns: 200 },
    );
  });

  test('aborted ⇒ halt, regardless of every other fact', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, fc.boolean(), async (facts, viaHalted) => {
        const f: Facts = {
          ...facts,
          lifecycle: { aborted: !viaHalted, halted: viaHalted },
        };
        const claim = await decide(f);
        expect(claim?.rule).toBe('aborted');
        expect(claim?.verdict).toEqual({ do: 'halt', reason: null });
      }),
      { numRuns: 300 },
    );
  });

  test('an AUTH sentinel ⇒ halt with that status, unless aborted', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFacts,
        fc.constantFrom('challenge' as const, 'logged-out' as const),
        async (facts, status) => {
          const f: Facts = {
            ...facts,
            lifecycle: { aborted: false, halted: false },
            sentinel: { status },
          };
          const claim = await decide(f);
          expect(claim?.verdict).toEqual({ do: 'halt', reason: { kind: 'sentinel', status } });
        },
      ),
      { numRuns: 200 },
    );
  });

  test('an armed recovery hold is SERVED unless aborted or auth-halted', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, async (facts) => {
        const f: Facts = {
          ...facts,
          lifecycle: { aborted: false, halted: false },
          sentinel: { status: facts.sentinel.status === 'ok' ? 'ok' : 'action-blocked' },
          recovery: { ...facts.recovery, phase: 'holding' },
        };
        const claim = await decide(f);
        expect(claim?.rule).toBe('recovery-hold');
        expect(claim?.verdict).toEqual({ do: 'run', effect: { id: 'serve-recovery-hold' } });
      }),
      { numRuns: 300 },
    );
  });

  test('a verified action block LADDERS, never halts', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, async (facts) => {
        const f: Facts = {
          ...facts,
          lifecycle: { aborted: false, halted: false },
          sentinel: { status: 'action-blocked' },
          recovery: { ...facts.recovery, phase: 'probing' },
        };
        const claim = await decide(f);
        expect(claim?.verdict).toEqual({
          do: 'run',
          effect: { id: 'enter-recovery', kind: 'rate-limited' },
        });
      }),
      { numRuns: 200 },
    );
  });

  test('the SAFETY prefix always wins: no growth rule can preempt it', async () => {
    const run: RunCtx = { mode: 'growth' };
    await fc.assert(
      fc.asyncProperty(arbFacts, async (facts) => {
        const safety = PROGRAM.safety.map((r) => r.decide(facts, run)).find((v) => v != null);
        if (safety === undefined) return;
        expect((await decide(facts))?.verdict).toEqual(safety);
      }),
      { numRuns: 400 },
    );
  });

  test('within the safety prefix, halt dominates run', async () => {
    const run: RunCtx = { mode: 'growth' };
    await fc.assert(
      fc.asyncProperty(arbFacts, async (facts) => {
        const verdicts = allVerdicts(PROGRAM.safety, facts, run);
        if (!verdicts.some((v) => v.do === 'halt')) return;
        expect((await decide(facts))?.verdict.do).toBe('halt');
      }),
      { numRuns: 400 },
    );
  });

  test('a run verdict carries AT MOST ONE effect — a burst is unrepresentable', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, async (facts) => {
        const verdict = (await decide(facts))?.verdict;
        if (verdict?.do !== 'run') return;
        // The type admits one `effect`; assert the value agrees (no arrays).
        expect(Array.isArray(verdict.effect)).toBe(false);
        expect(typeof verdict.effect.id).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  test('a due lifecycle unfollow is never displaced by a woven prune', async () => {
    await fc.assert(
      fc.asyncProperty(arbFacts, fc.double({ min: 0, max: 1, noNaN: true }), async (facts, draw) => {
        const f: Facts = {
          ...facts,
          lifecycle: { aborted: false, halted: false },
          sentinel: { status: 'ok' },
          recovery: { ...facts.recovery, phase: 'inactive' },
          ledger: { ...facts.ledger, atHardCeiling: false, withinActiveHours: true, atOperatingRate: false },
          pacing: { ...facts.pacing, model: 'organic', sessionOpen: true, hourlyVelocityCap: 999 },
          target: { current: { pk: 't1', username: 'targetone' } },
          cadence: { sweepDue: false, overdue: [] },
          queue: { queuedForTarget: 5, lowWaterCandidates: 0, targetExhausted: false },
          action: {
            due: rec('unfollow_queued'),
            pruneCandidate: { pk: 'p1', username: 'pruneme' },
            weaveDraw: draw,
            unfollowFraction: 1,
          },
        };
        const claim = await decide(f);
        expect(claim?.rule).toBe('action');
        const verdict = (claim as { verdict: RuleVerdict }).verdict;
        expect(verdict.do === 'run' && verdict.effect.id).toBe('churn-action');
      }),
      { numRuns: 200 },
    );
  });
});

// --- The prune mode ----------------------------------------------------------------

describe('prune-run rules', () => {
  const base = (over: Partial<Facts>): Facts => ({
    ...({
      lifecycle: { aborted: false, halted: false },
      clock: { now: 1_000 },
      sentinel: { status: 'ok' },
      recovery: { phase: 'inactive', holdRemainingMs: 0 },
      ledger: {
        atHardCeiling: false,
        atOperatingRate: false,
        withinActiveHours: true,
        msUntilCycleReset: 0,
        actionsInLastHour: 0,
      },
      pacing: {
        model: 'organic',
        sessionOpen: true,
        nextSessionStartAt: 0,
        hourlyVelocityCap: 99,
        activeHoursStart: 0,
      },
      target: { current: null },
      queue: { queuedForTarget: 0, lowWaterCandidates: 0, targetExhausted: false },
      cadence: { sweepDue: false, overdue: [] },
      action: { due: null, pruneCandidate: null, weaveDraw: null, unfollowFraction: 0 },
      streaks: {
        failed: 0,
        drift: 0,
        blocked: 0,
        lastBlockedCause: null,
        failingEntryThreshold: 8,
      },
      prune: { candidate: null, followsUsNow: false, whitelist: [], atDailyCap: false },
    } satisfies Facts),
    ...over,
  });

  test('the daily cap closes the mode before any candidate is considered', async () => {
    const claim = await decide(
      base({ prune: { candidate: { pk: 'c1', username: 'cand' }, followsUsNow: false, whitelist: [], atDailyCap: true } }),
      'prune-run',
    );
    expect(claim?.rule).toBe('prune-cap');
    expect(claim?.verdict).toEqual({ do: 'yield' });
  });

  test('an actionable candidate becomes the ONE unfollow effect', async () => {
    const claim = await decide(
      base({ prune: { candidate: { pk: 'c1', username: 'cand' }, followsUsNow: false, whitelist: [], atDailyCap: false } }),
      'prune-run',
    );
    expect(claim?.verdict).toEqual({
      do: 'run',
      effect: { id: 'woven-unfollow', now: 1_000, candidate: { pk: 'c1', username: 'cand' } },
    });
  });

  test('the live-graph guard and the whitelist both yield instead of acting', async () => {
    for (const prune of [
      { candidate: { pk: 'c1', username: 'cand' }, followsUsNow: true, whitelist: [], atDailyCap: false },
      { candidate: { pk: 'c1', username: 'cand' }, followsUsNow: false, whitelist: ['cand'], atDailyCap: false },
      { candidate: { pk: 'c1', username: null }, followsUsNow: false, whitelist: [], atDailyCap: false },
    ]) {
      expect((await decide(base({ prune }), 'prune-run'))?.verdict).toEqual({ do: 'yield' });
    }
  });

  test('the safety prefix still runs first in prune mode', async () => {
    const claim = await decide(
      base({ lifecycle: { aborted: true, halted: false } }),
      'prune-run',
    );
    expect(claim?.rule).toBe('aborted');
  });
});
