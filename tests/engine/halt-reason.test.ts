/**
 * The halt vocabulary: the typed union serializes to the SAME strings the
 * status surface, the composition root, and the renderer have always matched
 * on — a typed reason must never silently rename a wire value.
 *
 * `haltReasonKey` is a `switch` + `absurd` (not a ternary), and the rate-limit
 * STRING set is derived from the TYPED predicate, so the two surfaces cannot
 * drift: every assertion below is driven off `ALL_HALT_REASONS`.
 */

import {
  ALL_HALT_REASONS,
  type HaltReason,
  haltReasonKey,
  isRateLimitHalt,
  isRateLimitHaltKey,
} from '@/engine/halt-reason';

describe('haltReasonKey', () => {
  test('a sentinel halt carries its status', () => {
    expect(haltReasonKey({ kind: 'sentinel', status: 'challenge' })).toBe('sentinel:challenge');
    expect(haltReasonKey({ kind: 'sentinel', status: 'logged-out' })).toBe('sentinel:logged-out');
    expect(haltReasonKey({ kind: 'sentinel', status: 'action-blocked' })).toBe(
      'sentinel:action-blocked',
    );
  });

  test('every other reason serializes to its bare kind', () => {
    const cases: Array<[HaltReason, string]> = [
      [{ kind: 'runtime-error' }, 'runtime-error'],
      [{ kind: 'identity-changed' }, 'identity-changed'],
      [{ kind: 'reconciliation-failed' }, 'reconciliation-failed'],
      [{ kind: 'chain-exhausted' }, 'chain-exhausted'],
      [{ kind: 'recovery-exhausted' }, 'recovery-exhausted'],
      [{ kind: 'adapter-drift' }, 'adapter-drift'],
      [{ kind: 'seed-missing' }, 'seed-missing'],
      [{ kind: 'seed-unresolved' }, 'seed-unresolved'],
      [{ kind: 'no-current-target' }, 'no-current-target'],
      [{ kind: 'rate-limited' }, 'rate-limited'],
      [{ kind: 'actions-failing' }, 'actions-failing'],
      [{ kind: 'blocked-repeatedly' }, 'blocked-repeatedly'],
      [{ kind: 'scan-failed' }, 'scan-failed'],
      [{ kind: 'run-failed' }, 'run-failed'],
    ];
    for (const [reason, key] of cases) expect(haltReasonKey(reason)).toBe(key);
  });

  test('the enumeration covers every reason and every key is distinct', () => {
    const keys = ALL_HALT_REASONS.map(haltReasonKey);
    expect(new Set(keys).size).toBe(keys.length);
    // 14 bare kinds + one per sentinel status.
    expect(ALL_HALT_REASONS.length).toBe(18);
    for (const key of keys) expect(key).not.toBe('');
  });
});

describe('isRateLimitHalt', () => {
  test('true for every TYPED halt that means Instagram is throttling us', () => {
    expect(isRateLimitHalt({ kind: 'recovery-exhausted' })).toBe(true);
    expect(isRateLimitHalt({ kind: 'rate-limited' })).toBe(true);
    expect(isRateLimitHalt({ kind: 'blocked-repeatedly' })).toBe(true);
    expect(isRateLimitHalt({ kind: 'sentinel', status: 'action-blocked' })).toBe(true);
  });

  test('false for auth, structural, and non-throttling sentinel halts', () => {
    expect(isRateLimitHalt({ kind: 'sentinel', status: 'challenge' })).toBe(false);
    expect(isRateLimitHalt({ kind: 'sentinel', status: 'logged-out' })).toBe(false);
    expect(isRateLimitHalt({ kind: 'sentinel', status: 'ok' })).toBe(false);
    expect(isRateLimitHalt({ kind: 'chain-exhausted' })).toBe(false);
    expect(isRateLimitHalt({ kind: 'adapter-drift' })).toBe(false);
    expect(isRateLimitHalt({ kind: 'actions-failing' })).toBe(false);
  });
});

describe('isRateLimitHaltKey', () => {
  test('the string surface agrees with the typed one for EVERY reason', () => {
    for (const reason of ALL_HALT_REASONS) {
      expect(isRateLimitHaltKey(haltReasonKey(reason))).toBe(isRateLimitHalt(reason));
    }
  });

  test('the wire strings the composition root passes still work', () => {
    expect(isRateLimitHaltKey('recovery-exhausted')).toBe(true);
    expect(isRateLimitHaltKey('rate-limited')).toBe(true);
    expect(isRateLimitHaltKey('blocked-repeatedly')).toBe(true);
    expect(isRateLimitHaltKey('sentinel:action-blocked')).toBe(true);
    expect(isRateLimitHaltKey('sentinel:challenge')).toBe(false);
    expect(isRateLimitHaltKey('chain-exhausted')).toBe(false);
    expect(isRateLimitHaltKey('adapter-drift')).toBe(false);
    expect(isRateLimitHaltKey(null)).toBe(false);
    expect(isRateLimitHaltKey('not-a-halt')).toBe(false);
  });
});
