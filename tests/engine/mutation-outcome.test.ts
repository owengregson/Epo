/**
 * The unverified outcome (ADR 0308, spec §11.1 F7): a dispatched write that did not land with no
 * Instagram evidence is a park, never a rate-wall signal by itself; anything Instagram showed keeps
 * counting toward the ladder.
 */

import type { ChurnActionOutcome } from '@/engine/churn-types';
import { actChurn, type EngineActionContext } from '@/engine/engine-actions';
import { isUnverifiedOutcome, normalizeMutationOutcome } from '@/engine/mutation-outcome';
import { tempoOrReference } from '@/kernel/tempo';
import type { FollowRecord } from '@/store/types';

describe('normalizeMutationOutcome', () => {
  test('an undispatched or non-failed outcome passes through', () => {
    expect(normalizeMutationOutcome({ status: 'failed', cause: 'drift' }, false)).toEqual({ status: 'failed', cause: 'drift' });
    expect(normalizeMutationOutcome({ status: 'ok' }, true, 'none')).toEqual({ status: 'ok' });
  });

  test('a dispatched failure with Instagram evidence stays a refusal toward the ladder', () => {
    expect(normalizeMutationOutcome({ status: 'failed' }, true)).toEqual(
      { status: 'blocked', cause: 'tab-unhealthy', unverifiedClick: true });
    expect(normalizeMutationOutcome({ status: 'failed', cause: 'rate-limited' }, true, 'instagram')).toEqual(
      { status: 'blocked', cause: 'rate-limited', unverifiedClick: true });
  });

  test('a dispatched failure with no Instagram evidence is unverified: blocked, uncertain, no cause', () => {
    const outcome = normalizeMutationOutcome({ status: 'failed' }, true, 'none');
    expect(outcome).toEqual({ status: 'blocked', unverifiedClick: true });
    expect(isUnverifiedOutcome(outcome)).toBe(true);
  });

  test('only that outcome reads as unverified: a post-click tab stall, a refusal or a plain block do not', () => {
    const others: ChurnActionOutcome[] = [
      { status: 'blocked', cause: 'tab-unhealthy', unverifiedClick: true },
      { status: 'blocked', cause: 'rate-limited' },
      { status: 'blocked', cause: 'local-policy', unverifiedClick: true },
      { status: 'blocked' },
      { status: 'failed' },
    ];
    expect(others.map(isUnverifiedOutcome)).toEqual([false, false, false, false, false]);
    expect(isUnverifiedOutcome(null)).toBe(false);
  });
});

describe('actChurn on a blocked outcome', () => {
  /** The slice of the Engine one blocked lifecycle action reads; the last outcome is `outcome`. */
  function context(outcome: ChurnActionOutcome) {
    const noteOutcome = jest.fn();
    const enterRecovery = jest.fn(async () => 'halted' as const);
    const engineWait = jest.fn(async () => ({ completed: true }));
    const ctx = {
      deps: {
        tempo: undefined,
        churn: {
          execute: async () => outcome.status,
          lastBlockedCause: () => outcome.cause ?? null,
          lastActionOutcome: () => outcome,
          streaks: () => ({ failed: 0, drift: 0, blocked: 1 }),
        },
      },
      recovery: { noteOutcome, failingEntryThreshold: (n: number) => n, noteRecovered: () => null },
      actionsFailingHalt: 7,
      superseded: () => false,
      engineWait,
      enterRecovery,
    } as unknown as EngineActionContext;
    return { ctx, noteOutcome, enterRecovery, engineWait };
  }
  const rec = { accountPk: 'a', state: 'unfollow_queued' } as FollowRecord;

  test('unverified: a blocked park, and no rate-wall signal', async () => {
    const { ctx, noteOutcome, enterRecovery, engineWait } = context({ status: 'blocked', unverifiedClick: true });

    expect(await actChurn(ctx, rec, 0, new AbortController())).toEqual({ step: 'idle' });
    expect(noteOutcome).not.toHaveBeenCalled();
    expect(enterRecovery).not.toHaveBeenCalled();
    expect(engineWait).toHaveBeenCalledWith('engine:blocked-park', tempoOrReference(undefined).base('park.blocked'));
  });

  test('a block Instagram answered still counts toward the ladder', async () => {
    const { ctx, noteOutcome } = context({ status: 'blocked', cause: 'tab-unhealthy', unverifiedClick: true });

    await actChurn(ctx, rec, 0, new AbortController());
    expect(noteOutcome).toHaveBeenCalledWith('rate-limited');
  });
});
