/**
 * The read allowance a test budget runs under: the live derivation (kernel D6)
 * over the default settings, with a suite's own ceilings on top. Never a
 * hand-picked default; a suite that needs a tiny ceiling says so.
 */
import type { ReadBudgetConfig } from '@/governors/read-budget';
import { toReadAllowance } from '@/settings/read-allowance';
import { DEFAULT_SETTINGS } from '@/settings/settings';

export const readLimits = (over: Partial<ReadBudgetConfig> = {}): (() => ReadBudgetConfig) =>
  () => ({ ...toReadAllowance(DEFAULT_SETTINGS), ...over });
