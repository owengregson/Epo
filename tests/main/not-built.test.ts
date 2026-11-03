/**
 * The not-built projections (spec §13, §15.3): `basis` is 'not-built' and no count is fabricated; a block
 * before the build pushes the REAL status — `loggedIn` from the cookie, the boot view riding it — instead of
 * a signed-out flash.
 */

import { notBuiltStatus } from '@/main/modules/not-built';
import type { EpoStatus } from '@/types';
import { cleanupMainHarness, makeIgSession, newFoundation } from '../kit/main-harness';

afterAll(cleanupMainHarness);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('the not-built status is basis not-built, keeps connectivity, and counts nothing', () => {
  const s = notBuiltStatus(true, false);
  expect(s).toMatchObject({ basis: 'not-built', loggedIn: true, online: false, state: 'idle' });
  expect([s.actionsToday, s.remainingToday, s.queued, s.netToday]).toEqual([0, 0, 0, 0]);
});

test('a block before the build pushes loggedIn from the cookie, not a signed-out flash', async () => {
  const pushed: EpoStatus[] = [];
  const { foundation: f } = newFoundation({ onStatus: (s) => pushed.push(s) });
  f.stopForIncident('dashboard-recovery-exhausted');
  await settle();
  expect(pushed.at(-1)).toMatchObject({
    basis: 'not-built',
    loggedIn: true,
    runtime: expect.objectContaining({ blockedReason: 'dashboard-recovery-exhausted' }),
    boot: expect.objectContaining({ phase: 'starting' }),
  });
  await f.dispose();
});

test('signed out, the same block pushes loggedIn false', async () => {
  const pushed: EpoStatus[] = [];
  const { foundation: f } = newFoundation({ igSession: makeIgSession(null), onStatus: (s) => pushed.push(s) });
  f.stopForIncident('startup-failed');
  await settle();
  expect(pushed.at(-1)).toMatchObject({ basis: 'not-built', loggedIn: false });
  await f.dispose();
});
