/**
 * The gallery's complete Settings object, typed off the IPC contract so this
 * renderer module needs no `@/types` import. Re-exported by `fixtures.ts`.
 */

import type { Res } from '@/ipc/contract';

/** The settings shape the bridge's `getSettings` answers. */
type Settings = Res<'getSettings'>;

/**
 * A complete Settings object for the gallery.
 *
 * Written out rather than imported from `@/settings/settings`: that module
 * reads `node:fs` at import time, so pulling it in would drag the main
 * process's file layer into the renderer bundle (the build fails outright).
 * It is a typed literal, so adding a knob breaks THIS file at compile time —
 * which is the reminder to give the new knob a gallery value.
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
