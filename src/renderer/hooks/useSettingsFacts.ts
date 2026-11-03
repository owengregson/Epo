import { settingsFactsSignal } from '@/renderer/app/shell-context';
import type { SettingsFacts } from '@/shared/settings-facts';

/**
 * The store-derived Settings facts (spec §6.9): a projection row the shell subscribes to once, so counts
 * tick as the store changes. Null until the first pull; `built: false` until the store opens, when every
 * count is honest-unknown and shows as "—", never 0.
 */
export function useSettingsFacts(): SettingsFacts | null {
  return settingsFactsSignal.value;
}

/** A count from built facts, or null ("—") while the store has not answered. */
export function known(facts: SettingsFacts | null, read: (f: SettingsFacts) => number | null | undefined): number | null {
  if (facts === null || !facts.built) return null;
  return read(facts) ?? null;
}
