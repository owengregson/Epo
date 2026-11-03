/**
 * The read allowance for the CURRENT settings (kernel D6). The same limits the
 * pattern knobs derive, or the owner set, size the reads they cost; nothing
 * here is a number of its own.
 */
import { deriveReadAllowance, type ReadAllowance } from '../kernel/derive-reads';
import type { Settings } from './settings';

export function toReadAllowance(
  s: Pick<Settings, 'dailyHardCeiling' | 'dailyPlanSize' | 'followbackSweepHours' | 'sessionsPerDayMax'>,
): ReadAllowance {
  return deriveReadAllowance({
    dailyHardCeiling: s.dailyHardCeiling,
    dailyPlanSize: s.dailyPlanSize,
    followbackSweepHours: s.followbackSweepHours,
    sessionsPerDayMax: s.sessionsPerDayMax,
  });
}
