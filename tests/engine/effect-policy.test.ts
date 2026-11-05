/**
 * The effect-policy table: TOTAL over the effect ids, and the one rule the type
 * system enforces — a non-idempotent effect can never carry a retry schedule.
 */

import {
  EFFECT_POLICY,
  IG_EFFECT_IDS,
  type IgEffectId,
  policyFor,
} from '@/engine/effect-policy';
import { attempts } from '@/engine/schedule';

const EXPECTED: readonly IgEffectId[] = [
  'follow',
  'unfollow',
  'accept-request',
  'list-walk',
  'enrich',
  'notifications',
];

describe('EFFECT_POLICY', () => {
  test('is total over every Instagram-facing effect', () => {
    expect([...IG_EFFECT_IDS].sort()).toEqual([...EXPECTED].sort());
    for (const id of EXPECTED) expect(policyFor(id)).toBeDefined();
  });

  test('every mutation is non-idempotent and therefore NEVER retried', () => {
    for (const id of IG_EFFECT_IDS) {
      const p = policyFor(id);
      if (p.budget !== 'mutation') continue;
      expect(p.idempotent).toBe(false);
      expect(p.retry).toBe('never');
    }
  });

  test('the type-level rule holds for the whole table: !idempotent ⇒ retry never', () => {
    for (const id of IG_EFFECT_IDS) {
      const p = policyFor(id);
      if (!p.idempotent) expect(p.retry).toBe('never');
    }
  });

  test('a mutation is at most ONE per iteration (ADR 0205)', () => {
    expect(EFFECT_POLICY.follow.perIteration).toBe(1);
    expect(EFFECT_POLICY.unfollow.perIteration).toBe(1);
    expect(EFFECT_POLICY['accept-request'].perIteration).toBe(1);
  });

  test('a refusal never fabricates a fact: the record is untouched', () => {
    for (const id of IG_EFFECT_IDS) expect(policyFor(id).onRefusal).toBe('record-untouched');
  });

  test('every effect requires a tab, a session and connectivity', () => {
    for (const id of IG_EFFECT_IDS) {
      expect([...policyFor(id).requires].sort()).toEqual(['online', 'session', 'tab']);
    }
  });

  test('every retryable effect declares a BOUNDED schedule', () => {
    for (const id of IG_EFFECT_IDS) {
      const p = policyFor(id);
      if (p.retry === 'never') continue;
      expect(attempts(p.retry)).toBeLessThanOrEqual(5);
    }
  });

  test('every effect declares a distinct span name', () => {
    const spans = IG_EFFECT_IDS.map((id) => policyFor(id).span);
    expect(new Set(spans).size).toBe(spans.length);
  });
});
