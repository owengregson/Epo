import { SettingsService } from '@/main/modules/settings-service';
import { seedReopenState } from '@/main/services/reopen-wiring';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import { FAKE_PLAN_MATH, memoryFs } from '../kit/settings';
import { openTestStore } from '../kit/store';

const STAMP = 10_000;

function service(m: ReturnType<typeof memoryFs>) {
  return new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => false,
    math: FAKE_PLAN_MATH, now: () => 20_000, push: () => undefined });
}

function port(svc: SettingsService) {
  return { take: (pk: string) => svc.takeBookkeeping(pk),
    consume: () => svc.apply([{ op: 'consume-bookkeeping' }], 'system').kind === 'saved' };
}

test('backup recovery after successful consumption cannot give a legacy stamp to a second account', () => {
  const m = memoryFs({ [F.v1]: JSON.stringify({ ...DEFAULT_SETTINGS, sweepLastRunAt: STAMP }) });
  const first = service(m);
  const a = openTestStore(':memory:');
  const b = openTestStore(':memory:');
  a.setOwnPk('A'); b.setOwnPk('B');
  try {
    seedReopenState(a, 'A', port(first));
    expect(a.reopen.get()?.lastSweep).toMatchObject({ endedAt: STAMP });
    expect(JSON.parse(m.data.get(F.v2) ?? '{}').migration.bookkeeping).toBeNull();
    expect(JSON.parse(m.data.get(F.bak) ?? '{}').migration.bookkeeping.forPk).toBe('A');

    m.data.set(F.v2, '{corrupt');
    const restored = service(m);
    expect(restored.view().health.kind).toBe('restored-from-backup');
    seedReopenState(b, 'B', port(restored));
    expect(b.reopen.get()?.lastSweep ?? null).toBeNull();
    expect(restored.takeBookkeeping('A')).toMatchObject({ forPk: 'A', sweepLastRunAt: STAMP });
  } finally { a.close(); b.close(); }
});

test('a failed second rename preserves the durable owner through restart and backup recovery', () => {
  const m = memoryFs({ [F.v1]: JSON.stringify({ ...DEFAULT_SETTINGS, sweepLastRunAt: STAMP }) });
  const first = service(m);
  const rename = m.fs.rename;
  let writes = 0;
  m.fs.rename = (from, to) => {
    if (from.endsWith(F.tmp) && ++writes === 2) throw new Error('second rename failed');
    rename(from, to);
  };
  const a = openTestStore(':memory:');
  const b = openTestStore(':memory:');
  a.setOwnPk('A'); b.setOwnPk('B');
  try {
    seedReopenState(a, 'A', port(first));
    expect(writes).toBe(2);
    expect(a.reopen.get()?.lastSweep ?? null).toBeNull();
    expect(JSON.parse(m.data.get(F.v2) ?? '{}').migration.bookkeeping.forPk).toBe('A');
    expect(JSON.parse(m.data.get(F.bak) ?? '{}').migration.bookkeeping.forPk).toBe('A');

    m.fs.rename = rename;
    const reopened = service(m);
    seedReopenState(b, 'B', port(reopened));
    expect(b.reopen.get()?.lastSweep ?? null).toBeNull();
    m.data.set(F.v2, '{corrupt');
    const restored = service(m);
    expect(restored.view().health.kind).toBe('restored-from-backup');
    seedReopenState(b, 'B', port(restored));
    expect(b.reopen.get()?.lastSweep ?? null).toBeNull();
    seedReopenState(a, 'A', port(restored));
    expect(a.reopen.get()?.lastSweep).toMatchObject({ endedAt: STAMP });
    expect(restored.takeBookkeeping('A')).toBeNull();
  } finally { a.close(); b.close(); }
});
