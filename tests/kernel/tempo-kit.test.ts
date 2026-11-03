/** The tempo kit (`tests/kit/tempo.ts`) behaves as the suites rely on. */
import { referenceTempoSource } from '@/kernel/tempo';
import { fixedTempo, recordingTempo } from '../kit/tempo';

test('fixedTempo(1) resolves every drawable key exactly as the reference source does', () => {
  const ref = referenceTempoSource();
  const one = fixedTempo(1);
  for (const key of ['walk.page', 'gap.accept', 'dwell.visit', 'scroll.depth.dialog'] as const) {
    expect(one.policy(key).sample(() => 0.25)).toBe(ref.policy(key).sample(() => 0.25));
  }
  expect(one.enabled('dwell.before-press')).toBe(true);
});

test('a relaxed fixed tempo lengthens a reading wait and never shortens a pace-up base', () => {
  const ref = referenceTempoSource();
  const relaxed = fixedTempo(1.3);
  const brisk = fixedTempo(0.75);
  expect(relaxed.policy('walk.page').sample(() => 0.99)).toBeGreaterThan(ref.policy('walk.page').sample(() => 0.99));
  expect(brisk.base('park.blocked')).toBe(ref.base('park.blocked'));
  expect(relaxed.base('park.blocked')).toBeGreaterThan(ref.base('park.blocked'));
});

test('recordingTempo lists every key asked for, in order, and enables all', () => {
  const t = recordingTempo();
  t.base('beat.transient');
  t.policy('walk.rest').sample(() => 0.5);
  t.draw('gap.accept');
  expect(t.keys).toEqual(['beat.transient', 'walk.rest', 'gap.accept']);
  expect(t.enabled('ui.step-pause')).toBe(true);
});
