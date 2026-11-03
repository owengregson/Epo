/**
 * The gallery's Settings data, typed off renderer-safe types only: the view main builds for the fixture
 * document (a frozen snapshot, `settings-fixture.json`, pinned by tests/renderer/settings-fixture.test.ts),
 * the store-derived facts beside it, and the document parts the snapshot is built from. Names are invented.
 */

import type { Res } from '@/ipc/contract';
import type { SettingsFacts } from '@/shared/settings-facts';
import type { ProtectionSettings } from '@/shared/settings-model';
import type { SettingsCapabilities, SettingsView } from '@/shared/settings-view';
import snapshot from './settings-fixture.json';

/** A fixed instant (2 Nov 2026, 9:00 UTC): when the fixture's entries were added and the tour completed. */
const AT = Date.UTC(2026, 10, 2, 9);

/** Every capability on, as in the fully composed app. */
export const GALLERY_CAPABILITIES: SettingsCapabilities = { plan: true, tempo: true, boost: true, protectionEverywhere: true };

const PROTECTION: ProtectionSettings = {
  accounts: [
    { pk: '2001', username: 'theo.park', linkedAt: AT, formerUsernames: ['theo.parks'], addedAt: AT, source: 'you', valid: true },
    { pk: null, username: 'nora.h', linkedAt: null, formerUsernames: [], addedAt: AT, source: 'migrated', valid: true },
    { pk: null, username: 'not a handle!', linkedAt: null, formerUsernames: [], addedAt: AT, source: 'migrated', valid: false },
  ],
  words: [{ text: 'photographer', addedAt: AT }, { text: 'family', addedAt: AT }],
  wordMatch: 'anywhere',
  keepVerified: true,
};

/** What the fixture document sets over the defaults (the test rebuilds the view from these). */
export const GALLERY_DOC_PARTS = {
  rev: 7,
  seed: 'studio.lumen',
  protection: PROTECTION,
  app: { tourCompletedAt: AT },
} as const;

/** The view main builds for {@link GALLERY_DOC_PARTS}; the JSON is checked against `buildView` by a test. */
export const GALLERY_SETTINGS_VIEW = snapshot as unknown as SettingsView;

/** The facts the store would project beside it: the seed seen, protection counts, one census. */
export const GALLERY_SETTINGS_FACTS: SettingsFacts = {
  built: true,
  seed: {
    kind: 'seen', handle: 'studio.lumen', pk: '1001', currentUsername: 'studio.lumen', observedAt: AT,
    followers: 12_400, isPrivate: false, followersVisible: true,
  },
  ownAccount: { isPrivate: true },
  protection: {
    followingKnown: 1830,
    protectedFollowing: 214,
    byRule: { account: 2, verified: 41, bioWord: 171 },
    byWord: { photographer: 96, family: 75 },
    bioUnread: 96,
    entries: {
      'theo.park': { status: 'linked', currentUsername: 'theo.park', youFollow: true, followsYou: true },
      'nora.h': { status: 'not-seen', currentUsername: null, youFollow: null, followsYou: null },
      'not a handle!': { status: 'invalid', currentUsername: null, youFollow: null, followsYou: null },
    },
    kept: { total: 12, unreadable: 3 },
  },
  cleanup: { census: { at: AT, candidates: 318, protectedAmong: 41, verifiedComplete: true, tooLarge: false } },
};

/** The settings shape the bridge's `getSettings` answers (the older renderer's readers, until they go). */
type Settings = Res<'getSettings'>;

/**
 * A complete older-shape Settings object for the gallery, written out rather than imported from
 * `@/settings/settings` (that module reads `node:fs` at import time).
 */
export const GALLERY_SETTINGS: Settings = {
  seed: 'longish.handle.example',
  bandLow: 0.9,
  bandHigh: 1.5,
  peakLow: 1,
  peakHigh: 1.2,
  hardLow: 0.5,
  hardHigh: 3,
  minFollowers: 50,
  maxFollowers: 20000,
  privateBoost: 0.15,
  maxWaitForFollowbackDays: 4,
  holdAfterFollowbackDays: 2,
  maxRetries: 3,
  dailyHardCeiling: 65,
  dailyOperatingRate: 50,
  minDelayMinutes: 3,
  maxDelayMinutes: 7,
  jitterPercent: 30,
  activeHoursStart: 8,
  activeHoursEnd: 22,
  followbackSweepHours: 1,
  sweepLastRunAt: null,
  sweepIntervalFactor: 1,
  autoAcceptFollowRequests: true,
  dailyPlanSize: 60,
  lowWaterCandidates: 5,
  minFollowBackRate: 0.15,
  minPoolSize: 300,
  dryRun: false,
  pruneWhitelist: [],
  pruneBioFilterWords: [],
  pruneDailyLimit: 50,
  pruneScheduleDays: 0,
  pruneLastRunAt: null,
  pruneScanMinSeconds: 1,
  pruneScanMaxSeconds: 3,
  pacingModel: 'organic',
  dailyVolumeVariancePct: 28,
  restDayChancePct: 8,
  sessionsPerDayMin: 3,
  sessionsPerDayMax: 6,
  gapMedianSeconds: 95,
  gapFloorSeconds: 45,
  hourlyVelocityCap: 22,
  weaveEnabled: true,
  maxUnfollowFractionPerSession: 0.5,
  persona: 'balanced',
  pattern: { activityLevel: 'moderate', consistency: 'natural', rhythm: 'sessions', dayShape: 'balanced', weeklyShape: 'realistic', caution: 'standard', cleanup: 'steady', patience: 'normal' },
  tourCompletedAt: 1,
};
