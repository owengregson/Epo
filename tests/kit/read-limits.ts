/**
 * The read allowance a test budget runs under: the live derivation (kernel D6)
 * over the default settings, with a suite's own ceilings on top. Never a
 * hand-picked default; a suite that needs a tiny ceiling says so — and a suite
 * that sets its own profile total sets its own verify reserve (none unless it says).
 */
import type { ReadBudgetConfig } from '@/governors/read-budget';
import { effectiveFromV1 } from '@/settings/effective';
import { toReadAllowance } from '@/settings/read-allowance';
import { DEFAULT_SETTINGS } from '@/settings/settings';

export const readLimits = (over: Partial<ReadBudgetConfig> = {}): (() => ReadBudgetConfig) =>
  () => ({ ...toReadAllowance(effectiveFromV1(DEFAULT_SETTINGS)), ...(over.profiles === undefined ? {} : { verifyReserve: 0 }), ...over });
