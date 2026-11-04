/** Refusal preserves the v1 safety constraints at the actual settings → day-plan seam (spec §6.10). */
import { deriveQuietHours } from '@/kernel/derive-schedule';
import { MS_PER_DAY, MS_PER_HOUR } from '@/kernel/units';
import { SettingsService } from '@/main/modules/settings-service';
import { quietWindowOf } from '@/settings/effective';
import * as migration from '@/settings/migrate-v1';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { toPlanIntent } from '@/settings/plan-intent';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import { memoryFs } from '../kit/settings';

jest.mock('@/settings/migrate-v1', () => {
  const actual = jest.requireActual('@/settings/migrate-v1');
  return { ...actual, migrateV1: jest.fn(actual.migrateV1) };
});
const migrate = migration.migrateV1 as jest.MockedFunction<typeof migration.migrateV1>;
const { persona: _persona, pattern: _pattern, ...NUMBERS } = DEFAULT_SETTINGS;

function refused(patch: object) {
  const raw = JSON.stringify({ ...NUMBERS, ...patch });
  const m = memoryFs({ [F.v1]: raw });
  migrate.mockReturnValueOnce({ kind: 'refused', reasons: ['account-count'] });
  const svc = new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => true,
    now: () => 5_000, push: () => undefined });
  return { svc, m, raw, intent: toPlanIntent(svc.effective()) };
}

test('custom active hours, slower checks and scans, and lower cleanup survive without writing a v2 file', () => {
  const { svc, m, raw, intent } = refused({ activeHoursStart: 10, activeHoursEnd: 18, followbackSweepHours: 6,
    pruneDailyLimit: 10, pruneScheduleDays: 14, pruneScanMinSeconds: 2, pruneScanMaxSeconds: 6, dryRun: true });
  expect(intent).toMatchObject({ quietHours: { startMinute: 1080, endMinute: 600 }, checkSpacingOverrideMs: 6 * MS_PER_HOUR,
    cleanupPerDayCap: 10, patienceWaitMs: 14 * MS_PER_DAY, tempoOverrides: { 'walk.page': 2 } });
  expect(svc.effective().dryRun).toBe(true);
  expect(svc.protection().state).toBe('needs-review');
  expect(m.data.has(F.v2)).toBe(false);
  expect(m.data.get(F.v1)).toBe(raw);
});

test('the historical defaults use the plan’s derived quiet hours without invented timing or cap overrides', () => {
  const { intent } = refused({});
  expect(intent).toMatchObject({ quietHours: deriveQuietHours(DEFAULT_SETTINGS.pattern.dayShape),
    checkSpacingOverrideMs: null, cleanupPerDayCap: null, tempoOverrides: {},
    patienceWaitMs: DEFAULT_SETTINGS.maxWaitForFollowbackDays * MS_PER_DAY });
});

test('derived quiet-hour memoization never shares mutable windows or hides changed input', () => {
  const first = quietWindowOf({ kind: 'derived' }, 'balanced') as { startMinute: number; endMinute: number };
  first.startMinute = -1;
  expect(quietWindowOf({ kind: 'derived' }, 'balanced')).toEqual(deriveQuietHours('balanced'));
  expect(quietWindowOf({ kind: 'derived' }, 'nightowl')).toEqual(deriveQuietHours('nightowl'));
  const custom = { kind: 'custom' as const, startMinute: 100, endMinute: 200 };
  quietWindowOf(custom, 'balanced');
  custom.startMinute = 150;
  expect(quietWindowOf(custom, 'balanced')).toEqual({ startMinute: 150, endMinute: 200 });
});

test('all-day and overnight active windows retain their meaning', () => {
  expect(refused({ activeHoursStart: 7, activeHoursEnd: 7 }).intent.quietHours).toBeNull();
  expect(refused({ activeHoursStart: 22, activeHoursEnd: 6 }).intent.quietHours)
    .toEqual({ startMinute: 360, endMinute: 1320 });
});

test('refusal never shortens a safe-side legacy wait to the v2 editor’s smaller maximum', () => {
  expect(refused({ followbackSweepHours: 168, pruneScheduleDays: 365 }).intent)
    .toMatchObject({ checkSpacingOverrideMs: 168 * MS_PER_HOUR, patienceWaitMs: 365 * MS_PER_DAY });
});

test('a faster legacy read choice cannot speed up the plan; the slowest scan factor stays bounded', () => {
  expect(refused({ followbackSweepHours: 0.5, pruneScanMinSeconds: 0.5, pruneScanMaxSeconds: 1.5 }).intent)
    .toMatchObject({ checkSpacingOverrideMs: null, tempoOverrides: {} });
  expect(refused({ pruneScanMinSeconds: 10, pruneScanMaxSeconds: 20 }).intent.tempoOverrides).toEqual({ 'walk.page': 3 });
});

test('the completed intro survives refusal and an explicit start from recommended', () => {
  const { svc, m } = refused({ tourCompletedAt: 12345, dryRun: true });
  expect(svc.view().app.tourCompletedAt).toBe(12345);
  expect(svc.apply([{ op: 'migration', action: 'start-from-recommended' }], 'user').kind).toBe('saved');
  expect(svc.view().app.tourCompletedAt).toBe(12345);
  expect(JSON.parse(m.data.get(F.v2) ?? '{}')).toMatchObject({ app: { tourCompletedAt: 12345 }, prefs: { practice: true } });
});

test('raw protection entries survive refusal, unreadable items are counted, and review stays closed', () => {
  const { svc, m, raw } = refused({ pruneWhitelist: [' @Anna ', 'anna', '12345', 'bad name', 7, null],
    pruneBioFilterWords: [' Café ', 'cafe', 'shop', false], dryRun: true });
  expect(svc.view().protection.accounts.map((a) => [a.username, a.pk, a.valid]))
    .toEqual([['anna', null, true], ['12345', '12345', true], ['bad name', null, false]]);
  expect(svc.view().protection.words.map((w) => w.text)).toEqual(['Café', 'shop']);
  expect(svc.view().notices.filter((n) => n.kind === 'list-items-dropped').map((n) => n.data))
    .toEqual([{ list: 'accounts', count: 2 }, { list: 'words', count: 1 }]);
  expect(svc.apply([{ op: 'acknowledge-protection' }], 'user')).toMatchObject({ kind: 'refused', reason: 'protection-not-migrated' });
  expect(svc.protection().state).toBe('needs-review');
  expect(svc.effective().dryRun).toBe(true);
  expect(m.data.has(F.v2)).toBe(false);
  expect(m.data.get(F.v1)).toBe(raw);
});

test.each([null, [], true, 42, 'text'])('valid JSON that is not a settings object stays unreadable under review: %j', (value) => {
  const m = memoryFs({ [F.v1]: JSON.stringify(value) });
  const svc = new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => true,
    now: () => 5_000, push: () => undefined });
  expect(svc.view().health.kind).toBe('defaults-after-unreadable');
  expect(svc.protection().state).toBe('needs-review');
  expect(m.data.has(F.v2)).toBe(false);
});
