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
    'chainDetail',
    'queueList',
    'restartFromSeed',
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
