/**
 * BehaviorCard pacing-model surface — the pure contract behind the gating
 * (regression: organic-pacing-unreachable). The card must (a) expose BOTH
 * models with plain, neutral labels, (b) gate exactly the knobs only the
 * adaptive-sessions model consults, and (c) leave the knobs live under both
 * models ungated. The gated/live split is traced in ADAPTIVE_ONLY_KNOBS's doc
 * comment to each knob's actual consumer (engine organic branch, SessionPlanner,
 * woven-prune path vs. rate governor/scanner/churn windows).
 */
import {
  ADAPTIVE_ONLY_KNOBS,
  ADAPTIVE_ONLY_NOTE,
  PACING_OPTIONS,
  pacingModelHint,
} from '@/renderer/cards/settings/BehaviorCard';
import type { PatternSettings } from '@/settings/pattern-map';

describe('pacing model control', () => {
  test('both models are selectable, adaptive first (the recommended default)', () => {
    expect(PACING_OPTIONS.map((o) => o.value)).toEqual(['organic', 'legacy']);
  });

  test('user-facing copy is neutral and plain (internal values never leak)', () => {
    const copy = [
      ...PACING_OPTIONS.map((o) => o.label),
      pacingModelHint('organic'),
      pacingModelHint('legacy'),
      ADAPTIVE_ONLY_NOTE,
    ].join(' ');
    for (const banned of ['organic', 'legacy', 'human', 'bot', 'natural-looking']) {
      expect(copy.toLowerCase()).not.toContain(banned);
    }
  });

  test('each model gets a distinct, honest description', () => {
    expect(pacingModelHint('organic')).not.toBe(pacingModelHint('legacy'));
    // The steady-intervals description must state that the session knobs are inert.
    expect(pacingModelHint('legacy')).toContain('inactive');
  });
});

describe('knob gating — exactly the adaptive-only knobs are gated', () => {
  const ALL_KNOBS: Array<keyof PatternSettings> = [
    'activityLevel',
    'consistency',
    'rhythm',
    'dayShape',
    'weeklyShape',
    'caution',
    'cleanup',
    'patience',
  ];

  test('gated: the six knobs only the SessionPlanner/organic engine branch consults', () => {
    expect([...ADAPTIVE_ONLY_KNOBS].sort()).toEqual(
      ['caution', 'cleanup', 'consistency', 'dayShape', 'rhythm', 'weeklyShape'].sort(),
    );
  });

  test('live under both models: activity level (daily volume) and patience (lifecycle windows)', () => {
    const live = ALL_KNOBS.filter((k) => !ADAPTIVE_ONLY_KNOBS.has(k));
    expect(live.sort()).toEqual(['activityLevel', 'patience'].sort());
  });

  test('the gate note names the requirement in the UI wording, not internals', () => {
    expect(ADAPTIVE_ONLY_NOTE).toBe('Requires adaptive sessions');
  });
});
