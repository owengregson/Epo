import { SettingsService } from '@/main/modules/settings-service';
import { seedReopenState } from '@/main/services/reopen-wiring';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import { FAKE_PLAN_MATH, memoryFs } from '../kit/settings';
import { openTestStore } from '../kit/store';

const STAMP = 10_000;

function rig() {
  const m = memoryFs({ [F.v1]: JSON.stringify({ ...DEFAULT_SETTINGS, sweepLastRunAt: STAMP }) });
  const svc = new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => false,
    math: FAKE_PLAN_MATH, now: () => 20_000, push: () => undefined });
  const a = openTestStore(':memory:');
  const b = openTestStore(':memory:');
  a.setOwnPk('A'); b.setOwnPk('B');
  const bookkeeping = {
    take: (pk: string) => svc.takeBookkeeping(pk),
    consume: () => svc.apply([{ op: 'consume-bookkeeping' }], 'system').kind === 'saved',
  };
  return { m, svc, a, b, bookkeeping, close: () => { a.close(); b.close(); } };
}

test('a failed durable consume cannot seed either account from an unowned settings stamp', () => {
  const r = rig();
  try {
    r.m.failOn('rename');
    seedReopenState(r.a, 'A', r.bookkeeping);
    seedReopenState(r.b, 'B', r.bookkeeping);
    expect(r.a.reopen.get()?.lastSweep ?? null).toBeNull();
    expect(r.b.reopen.get()?.lastSweep ?? null).toBeNull();
    expect(r.svc.takeBookkeeping('B')).toBeNull();
    expect(r.svc.takeBookkeeping('A')).toMatchObject({ forPk: 'A', sweepLastRunAt: STAMP });
  } finally { r.close(); }
});

test('after a failed consume recovers, only its first account can receive the stamp', () => {
  const r = rig();
  try {
    r.m.failOn('rename');
    seedReopenState(r.a, 'A', r.bookkeeping);
    r.m.failOn('none');
    seedReopenState(r.b, 'B', r.bookkeeping);
    expect(r.b.reopen.get()?.lastSweep ?? null).toBeNull();
    seedReopenState(r.a, 'A', r.bookkeeping);
    expect(r.a.reopen.get()?.lastSweep).toMatchObject({ endedAt: STAMP });
    expect(r.svc.takeBookkeeping('A')).toBeNull();
    expect(JSON.parse(r.m.data.get(F.v2) ?? '{}').migration.bookkeeping).toBeNull();
  } finally { r.close(); }
});
