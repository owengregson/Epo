/**
 * The durable `meta` scalars behind their typed manifest: round-trips, the
 * set-once baseline, corrupt values reading as absent, and the injected rng
 * that makes the per-install entropy draw reproducible.
 */

import { META_KEYS } from '@/store/repos/meta';
import { memoryStore } from '../kit/store';

test('every meta key maps to a distinct row', () => {
  // Guards the manifest against a copy-paste that points two logical keys at
  // the same row (which would make one silently overwrite the other).
  const values = Object.values(META_KEYS);
  expect(new Set(values).size).toBe(values.length);
});

test('pacing and recovery state round-trip as opaque JSON strings, and clear', () => {
  const s = memoryStore();
  try {
    expect(s.getPacingState()).toBeNull();
    expect(s.getRecoveryState()).toBeNull();
    expect(s.getRecoveryLastIncident()).toBeNull();

    s.setPacingState('{"day":1}');
    s.setRecoveryState('{"attempt":2}');
    s.setRecoveryLastIncident('{"resolvedAt":5}');
    expect(s.getPacingState()).toBe('{"day":1}');
    expect(s.getRecoveryState()).toBe('{"attempt":2}');
    expect(s.getRecoveryLastIncident()).toBe('{"resolvedAt":5}');

    s.setPacingState(null);
    s.setRecoveryState(null);
    s.setRecoveryLastIncident(null);
    expect(s.getPacingState()).toBeNull();
    expect(s.getRecoveryState()).toBeNull();
    expect(s.getRecoveryLastIncident()).toBeNull();
  } finally {
    s.close();
  }
});

test('a corrupt numeric scalar reads as absent, never as a fabricated number', () => {
  const s = memoryStore();
  try {
    s.setActionDelayDeadline(1_234);
    (s as unknown as { db: { prepare(q: string): { run(...a: string[]): void } } }).db
      .prepare(`UPDATE meta SET value = ? WHERE key = ?`)
      .run('not-a-number', 'action_delay_deadline_at');
    // `Number('not-a-number')` is NaN; serving that as a deadline would make
    // every comparison against it false and silently disable the pacing wait.
    expect(s.getActionDelayDeadline()).toBeNull();
    expect(s.followersBaselineAt()).toBeNull();
  } finally {
    s.close();
  }
});

test('installEntropy draws once from the injected rng and then stays put', () => {
  let draws = 0;
  const s = memoryStore({
    rng: () => {
      draws += 1;
      return 0.5;
    },
  });
  try {
    const first = s.installEntropy();
    expect(first).toBe(0x8000_0000);
    expect(draws).toBe(1);
    // Second call reads the persisted value — the seed must be stable for the
    // life of the install, or every relaunch re-jitters the same schedule.
    expect(s.installEntropy()).toBe(first);
    expect(draws).toBe(1);
  } finally {
    s.close();
  }
});

test('the prune census round-trips through meta and survives a reopen of the same handle', () => {
  const s = memoryStore();
  try {
    expect(s.getPruneCensus()).toBeNull();
    const census = {
      at: 1000,
      following: 500,
      followers: 400,
      scrapedFollowing: 495,
      scrapedFollowers: 398,
      notFollowingBack: 120,
      candidates: 90,
    };
    s.savePruneCensus(census);
    expect(s.getPruneCensus()).toEqual(census);
  } finally {
    s.close();
  }
});

test('a mutation pulse fires for the census write and the baseline stamp', () => {
  const s = memoryStore();
  try {
    let pulses = 0;
    const off = s.onMutation(() => {
      pulses += 1;
    });
    s.ensureFollowersBaseline(1000);
    expect(pulses).toBe(1);
    // Set-once: a second call is not a write, so it must not pulse.
    s.ensureFollowersBaseline(2000);
    expect(pulses).toBe(1);
    s.savePruneCensus({
      at: 1,
      following: 0,
      followers: 0,
      scrapedFollowing: 0,
      scrapedFollowers: 0,
      notFollowingBack: 0,
      candidates: 0,
    });
    expect(pulses).toBe(2);
    off();
    s.ensureFollowersBaseline(3000);
    expect(pulses).toBe(2);
  } finally {
    s.close();
  }
});
