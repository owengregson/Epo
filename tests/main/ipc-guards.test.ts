/**
 * The IPC boundary guards (ADR 1009).
 *
 * `checkArgs` is pure, so this suite exercises the real schemas without
 * electron: the four guarded channels accept what the renderer actually sends
 * and refuse the shapes that would otherwise reach the store or the settings
 * file. `register.ts` turns a refusal into the channel's typed fallback — the
 * guard itself never throws, and that is asserted here too.
 */

import { CHANNELS } from '@/ipc/contract';
import { checkArgs, GUARDS } from '@/ipc/guards';
import { DEFAULT_SETTINGS } from '@/settings/settings';

test('only channels with scalar arguments carry a guard', () => {
  expect(Object.keys(GUARDS).sort()).toEqual([
    'applySettings',
    'chainDetail',
    'checkSeed',
    'keptList',
    'previewBoost',
    'previewSettings',
    'queueList',
    'restartFromSeed',
    'setLogStream',
    'startBoost',
    'suggestAccounts',
    'updateSettings',
  ]);
  // Every guarded name is a real channel.
  for (const method of Object.keys(GUARDS)) {
    expect(CHANNELS).toHaveProperty(method);
  }
});

test('an unguarded channel is always accepted', () => {
  expect(checkArgs('status', [])).toBeNull();
  expect(checkArgs('growthSeries', [])).toBeNull();
  expect(checkArgs('growthSeries', [30])).toBeNull();
});

describe('restartFromSeed', () => {
  test.each([['natgeo'], ['@natgeo'], ['some.user_1']])('accepts %s', (seed) => {
    expect(checkArgs('restartFromSeed', [seed])).toBeNull();
  });

  test.each([
    ['', 'empty'],
    ['a'.repeat(40), 'over the handle limit'],
    ['bad user', 'whitespace'],
    ['../../etc/passwd', 'path characters'],
  ])('refuses %s (%s)', (seed) => {
    expect(checkArgs('restartFromSeed', [seed])).not.toBeNull();
  });

  test('refuses a non-string without throwing', () => {
    expect(checkArgs('restartFromSeed', [{ toString: () => 'x' }])).toMatchObject({ arg: 0 });
    expect(checkArgs('restartFromSeed', [])).toMatchObject({ arg: 0 });
  });
});

describe('queueList', () => {
  test('accepts a real lifecycle state', () => {
    expect(checkArgs('queueList', ['pending_followback'])).toBeNull();
  });
  test('refuses anything outside the union', () => {
    expect(checkArgs('queueList', ['deleted'])).not.toBeNull();
    expect(checkArgs('queueList', [7])).not.toBeNull();
  });
});

describe('chainDetail', () => {
  test('accepts an account pk', () => {
    expect(checkArgs('chainDetail', ['1783245'])).toBeNull();
  });
  test('refuses a non-pk string', () => {
    expect(checkArgs('chainDetail', ['abc'])).not.toBeNull();
    expect(checkArgs('chainDetail', ["1' OR 1=1--"])).not.toBeNull();
  });
});

describe('updateSettings', () => {
  test('accepts the full settings object the renderer round-trips', () => {
    expect(checkArgs('updateSettings', [DEFAULT_SETTINGS])).toBeNull();
  });

  test('accepts a one-knob patch', () => {
    expect(checkArgs('updateSettings', [{ dryRun: true }])).toBeNull();
  });

  test('accepts an OUT-OF-RANGE value: clamping is sanitizeSettings, not the guard', () => {
    // ADR 0103: the semantics here are coercion, not validation — `jitterPercent`
    // 100 must become 90, never a rejection that reverts the user's save.
    expect(checkArgs('updateSettings', [{ jitterPercent: 100 }])).toBeNull();
    expect(checkArgs('updateSettings', [{ minDelayMinutes: -5 }])).toBeNull();
    expect(checkArgs('updateSettings', [{ pruneWhitelist: 'not-an-array' }])).toBeNull();
  });

  test('refuses a payload that is not a plain object of declared knobs', () => {
    expect(checkArgs('updateSettings', [null])).not.toBeNull();
    expect(checkArgs('updateSettings', ['seed=x'])).not.toBeNull();
    expect(checkArgs('updateSettings', [[{ dryRun: true }]])).not.toBeNull();
    expect(checkArgs('updateSettings', [{ __proto__: { polluted: true }, notAKnob: 1 }]))
      .not.toBeNull();
  });
});

describe('the Settings v2, Boost and live rows (shape only)', () => {
  test('applySettings and previewSettings take 1–64 known ops of the right shape', () => {
    const ops = [
      { op: 'intent', key: 'activity', value: 'light' },
      { op: 'intent', key: 'quietHours', value: { kind: 'custom', startMinute: 1380, endMinute: 360 } },
      { op: 'intent', key: 'daysOff', value: [0, 6] },
      { op: 'override', key: 'pace.hourlyCap', value: 18 },
      { op: 'override', key: 'audience.followerRange', value: { min: 50, max: 900 } },
      { op: 'protect-add', entries: [{ username: 'jane', pk: '12' }], source: 'you' },
      { op: 'word-add', texts: ['cafe'] },
      { op: 'protect-rule', rule: 'wordMatch', value: 'whole-word' },
      { op: 'pref', key: 'boost.hours', value: 30 },
      { op: 'migration', action: 'retry' },
      { op: 'reset', scope: { kind: 'section', section: 'pace' } },
    ];
    expect(checkArgs('applySettings', [ops])).toBeNull();
    expect(checkArgs('previewSettings', [ops])).toBeNull();
  });

  test.each([
    ['no ops', []],
    ['an unknown op', [{ op: 'format-disk' }]],
    ['an unknown intent value', [{ op: 'intent', key: 'activity', value: 'turbo' }]],
    ['seven days off', [{ op: 'intent', key: 'daysOff', value: [0, 1, 2, 3, 4, 5, 6] }]],
    ['a quiet minute off the clock', [{ op: 'intent', key: 'quietHours', value: { kind: 'custom', startMinute: 1440, endMinute: 0 } }]],
    ['an unknown parameter', [{ op: 'override', key: 'pace.warp', value: 1 }]],
    ['a non-finite value', [{ op: 'override', key: 'pace.hourlyCap', value: Number.NaN }]],
    ['a non-digit pk', [{ op: 'protect-link', pk: 'abc', username: 'x', at: 1 }]],
    ['too many words in one op', [{ op: 'word-add', texts: Array.from({ length: 51 }, (_, i) => `w${i}`) }]],
    ['an unknown migration action', [{ op: 'migration', action: 'delete-v1' }]],
  ])('refuses %s', (_label, ops) => {
    expect(checkArgs('applySettings', [ops])).not.toBeNull();
  });

  test('checkSeed takes a handle; suggestAccounts a short query and a scope; keptList a page', () => {
    expect(checkArgs('checkSeed', ['@natgeo'])).toBeNull();
    expect(checkArgs('checkSeed', ['bad user'])).not.toBeNull();
    expect(checkArgs('suggestAccounts', ['@jan', 'following'])).toBeNull();
    expect(checkArgs('suggestAccounts', ['x'.repeat(32), 'following'])).not.toBeNull();
    expect(checkArgs('suggestAccounts', ['jan', 'everyone'])).not.toBeNull();
    expect(checkArgs('keptList', [0])).toBeNull();
    expect(checkArgs('keptList', [10_001])).not.toBeNull();
    expect(checkArgs('keptList', [1.5])).not.toBeNull();
  });

  test('startBoost takes finite hours and the alsoStart option; setLogStream a boolean', () => {
    expect(checkArgs('startBoost', [12, { alsoStart: false }])).toBeNull();
    expect(checkArgs('startBoost', [99, { alsoStart: true }])).toBeNull();
    expect(checkArgs('startBoost', [Number.POSITIVE_INFINITY, { alsoStart: true }])).not.toBeNull();
    expect(checkArgs('startBoost', [12, {}])).not.toBeNull();
    expect(checkArgs('previewBoost', ['12'])).not.toBeNull();
    expect(checkArgs('setLogStream', [true])).toBeNull();
    expect(checkArgs('setLogStream', ['yes'])).not.toBeNull();
  });
});
