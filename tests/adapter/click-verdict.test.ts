/**
 * Click verdicts (spec §9.7, F2a step 6): a review that consumes the work is an
 * ActionReviewedError carrying its verdict — never a deferral — and a deferral
 * may carry the typed refusal and the instant the work may run again.
 */
import { ActionDeferredError, ActionReviewedError } from '@/adapter/errors';
import { CLICK_VERDICT_KINDS, type ClickVerdict } from '@/shared/click-verdict';

const EVERY: readonly ClickVerdict[] = [
  { kind: 'proceed' }, { kind: 'reheld' }, { kind: 'not-due' }, { kind: 'request-pending' }, { kind: 'already-gone' },
  { kind: 'unavailable', evidence: 'renamed' },
  { kind: 'protected', by: 'bio-word', match: 'photographer' },
  { kind: 'protection-unknown', missing: 'bio' },
  { kind: 'protection-paused', state: 'needs-review' },
  { kind: 'deferred', reason: 'hourly-cap', until: 5_000 },
];

test('the verdict vocabulary is the spec union, one example per kind', () => {
  expect(EVERY.map((v) => v.kind)).toEqual([...CLICK_VERDICT_KINDS]);
});

test('ActionReviewedError carries its verdict and is not a deferral', () => {
  const verdict: ClickVerdict = { kind: 'protected', by: 'account', match: '@keep.me' };
  const e = new ActionReviewedError(verdict);
  expect(e).toBeInstanceOf(Error);
  expect(e).toBeInstanceOf(ActionReviewedError);
  expect(e).not.toBeInstanceOf(ActionDeferredError);
  expect(e.verdict).toBe(verdict);
  expect(e.name).toBe('ActionReviewedError');
  expect(e.message).toContain('protected');
});

test('ActionDeferredError keeps today\'s shape: the message is the reason, no until', () => {
  const e = new ActionDeferredError('shared mutation delay still owed');
  expect(e.message).toBe('shared mutation delay still owed');
  expect(e.reason).toBe('shared mutation delay still owed');
  expect(e.until).toBeNull();
  expect(e.name).toBe('ActionDeferredError');
});

test('ActionDeferredError may carry a typed refusal and the instant it lifts', () => {
  const e = new ActionDeferredError('plan refused: hourly-cap', { reason: 'hourly-cap', until: 1_234 });
  expect(e.message).toBe('plan refused: hourly-cap');
  expect(e.reason).toBe('hourly-cap');
  expect(e.until).toBe(1_234);
});
