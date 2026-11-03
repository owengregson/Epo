/**
 * Settings recovery (spec §6.6, §6.10): a refused migration keeps running on v1's own numbers with practice
 * mode carried, writes no v2 after any user op and keeps unfollows paused; retry and start-over recover; a
 * deleted v2 with its backup present restores the backup under review, never a silent re-migration.
 */
import { SettingsService } from '@/main/modules/settings-service';
import * as migrate from '@/settings/migrate-v1';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import { FAKE_PLAN_MATH, memoryFs } from '../kit/settings';

jest.mock('@/settings/migrate-v1', () => {
  const actual = jest.requireActual('@/settings/migrate-v1');
  return { ...actual, migrateV1: jest.fn(actual.migrateV1) };
});
const migrateV1 = migrate.migrateV1 as jest.MockedFunction<typeof migrate.migrateV1>;

// A numbers-only v1 file (no persona, no pattern): its hand-set numbers are what v1 runs on.
const { persona: _persona, pattern: _pattern, ...NUMBERS } = DEFAULT_SETTINGS;
const V1 = JSON.stringify({ ...NUMBERS, dryRun: true, pruneWhitelist: ['anna', 7], dailyOperatingRate: 61 });
function service(files: Record<string, string>) {
  const m = memoryFs(files);
  const svc = new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => true, math: FAKE_PLAN_MATH,
    now: () => 5_000, push: () => undefined });
  return { svc, m };
}

beforeEach(() => migrateV1.mockClear());

test('a refusal keeps practice mode and v1’s numbers, keeps unfollows paused, and writes no v2 after any user op', () => {
  migrateV1.mockReturnValueOnce({ kind: 'refused', reasons: ['account-count'] });
  const { svc, m } = service({ [F.v1]: V1 });
  expect(svc.view().health).toEqual({ kind: 'migration-refused', detail: 'account-count' });
  expect(svc.effective()).toMatchObject({ dryRun: true, dailyOperatingRate: 61 });
  expect(svc.view().protectionState).toBe('needs-review');
  expect(svc.protection().state).toBe('needs-review');
  expect(svc.view().protection.accounts.map((a) => a.username)).toEqual(['anna']);
  expect(svc.apply([{ op: 'pref', key: 'practice', value: false }], 'user')).toMatchObject({ kind: 'refused', reason: 'migration-pending' });
  expect(svc.apply([{ op: 'acknowledge-protection' }], 'user')).toMatchObject({ kind: 'refused', reason: 'protection-not-migrated' });
  expect(svc.apply([{ op: 'ui', mode: 'advanced' }], 'user').kind).toBe('saved');
  expect(svc.view().mode).toBe('advanced');
  expect([m.data.has(F.v2), m.data.has(F.created)]).toEqual([false, false]);
  expect(svc.resolveSettings().dryRun).toBe(true);
});

test('retry runs the migration again now; it succeeds once the cause is gone', () => {
  migrateV1.mockReturnValueOnce({ kind: 'refused', reasons: ['seed'] });
  const { svc, m } = service({ [F.v1]: V1 });
  expect(svc.apply([{ op: 'migration', action: 'retry' }], 'user').kind).toBe('saved');
  expect(svc.view().health.kind).toBe('migrated');
  expect(m.data.has(F.v2)).toBe(true);
  expect(svc.effective().dryRun).toBe(true);
});

test('start from recommended writes a fresh v2 keeping the v1 lists and practice mode, under review', () => {
  migrateV1.mockReturnValueOnce({ kind: 'refused', reasons: ['word-count'] });
  const { svc, m } = service({ [F.v1]: V1 });
  expect(svc.apply([{ op: 'migration', action: 'start-from-recommended' }], 'user').kind).toBe('saved');
  expect(svc.view()).toMatchObject({ protectionState: 'needs-review', prefs: { practice: true }, intent: { activity: 'moderate' } });
  expect(svc.view().protection.accounts.map((a) => a.username)).toEqual(['anna']);
  expect(JSON.parse(m.data.get(F.v2) ?? '{}').rev).toBe(1);
});

test('v2 deleted with its backup present: the backup is restored under review, no re-migration', () => {
  const { svc: first, m } = service({ [F.v1]: V1 });
  first.apply([{ op: 'protect-add', entries: [{ username: 'later' }], source: 'you' }], 'user');
  first.apply([{ op: 'pref', key: 'acceptRequests', value: false }], 'user');
  const files = Object.fromEntries([...m.data].filter(([k]) => k !== F.v2));
  migrateV1.mockClear();
  const { svc } = service(files);
  expect(svc.view().health.kind).toBe('restored-from-backup');
  expect(svc.view().protectionState).toBe('needs-review');
  expect(svc.view().protection.accounts.map((a) => a.username)).toContain('later');
  expect(migrateV1).not.toHaveBeenCalled();
});
