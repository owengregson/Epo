/**
 * The settings service's v2 surface over its v1 internals (spec §6.9): the
 * effective record, the protection index compiled with the NEW predicate (bio
 * words protect everyone, not only follow-backs), the capability flags, the plan
 * preview port and the transitional view.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanPreviewPort } from '@/governors/plan-types';
import { SettingsService } from '@/main/modules/settings-service';
import { effectiveFromV1 } from '@/settings/effective';
import { protectionVerdict } from '@/shared/unfollow-protection';
import { setLevel } from '@/utils/logger';

let dir: string;
let svc: SettingsService;
beforeAll(() => setLevel('error'));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epo-settings-v2-'));
  svc = new SettingsService({ userDataDir: dir, graph: () => null });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('effective() is the v1 file as v1 resolves it', () => {
  expect(svc.effective()).toEqual(effectiveFromV1(svc.resolveSettings()));
});

test('protection() compiles the v1 lists with the new predicate, once per revision', async () => {
  await svc.updateSettings({ pruneWhitelist: ['@Jane'], pruneBioFilterWords: ['Café'] });
  const idx = svc.protection();
  expect(svc.protection()).toBe(idx);
  // A bio word now protects someone who does not follow back.
  expect(protectionVerdict({ pk: '7', username: 'stranger', bio: 'CAFE owner', isVerified: false }, idx))
    .toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
  expect(protectionVerdict({ pk: '8', username: 'jane', bio: '', isVerified: false }, idx).kind).toBe('protected');
  await svc.updateSettings({ pruneBioFilterWords: [] });
  expect(svc.protection()).not.toBe(idx);
  expect(svc.protection().words).toEqual([]);
});

test('capabilities start off and each wiring site sets its own flag', () => {
  expect(svc.view().capabilities).toEqual({ plan: false, tempo: false, boost: false, protectionEverywhere: false });
  svc.setCapabilities({ protectionEverywhere: true });
  svc.setCapabilities({ plan: true });
  expect(svc.view().capabilities).toEqual({ plan: true, tempo: false, boost: false, protectionEverywhere: true });
});

test('the plan preview port is absent until the plan wiring registers it, and can be withdrawn', () => {
  expect(svc.planPort()).toBeNull();
  const port: PlanPreviewPort = { previewDays: () => [] };
  svc.setPlanPort(port);
  expect(svc.planPort()).toBe(port);
  // Registering the port sets no capability: the plan wiring sets `plan` itself.
  expect(svc.view().capabilities.plan).toBe(false);
  svc.setPlanPort(null);
  expect(svc.planPort()).toBeNull();
});

test('the transitional view carries the v1 file as intent, seed, protection and prefs', async () => {
  await svc.updateSettings({ seed: 'studio', dryRun: true, pruneWhitelist: ['12345'], activeHoursStart: 9, activeHoursEnd: 21 });
  const v = svc.view();
  expect(v).toMatchObject({
    health: { kind: 'ok' }, mode: 'easy', seed: 'studio', protectionState: 'ready', params: [],
    prefs: { practice: true, acceptRequests: true },
    intent: { activity: 'moderate', quietHours: { kind: 'custom', startMinute: 1260, endMinute: 540 } },
    reads: { window: 'plan-day', backstop: 'trailing-24h' },
  });
  expect(v.protection.accounts.map((a) => [a.username, a.pk])).toEqual([['12345', '12345']]);
  expect(v.options.paceCards.map((c) => c.id)).toEqual(['gentle', 'balanced', 'faster']);
});
