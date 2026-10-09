/**
 * The persistent Instagram session, as a port.
 *
 * `Foundation` needs exactly two things from Electron's session layer: the
 * `ds_user_id` cookie (which IS the logged-in account pk) and a way to wipe the
 * partition on a data clear. Keeping them behind this interface is what makes
 * the composition root electron-free — main injects the real implementation,
 * tests inject a two-line fake.
 */

import { session } from 'electron';
import { IG_PARTITION } from '@/adapter/tab';
import * as logger from '@/utils/logger';

export interface IgSessionPort {
  /**
   * The first non-empty value of cookie `name` in the IG partition, or null
   * when it is absent or unreadable. Never throws — an unreadable cookie is a
   * transient state, not an error condition.
   */
  readCookie(name: string): Promise<string | null>;
  /** Wipe the partition's storage and cache (a logout). */
  clear(): Promise<void>;
}

/** The real, Electron-backed session port (main process only). */
export function electronIgSession(): IgSessionPort {
  return {
    async readCookie(name: string): Promise<string | null> {
      try {
        const cookies = await session.fromPartition(IG_PARTITION).cookies.get({ name });
        return cookies.find((c) => c.value.length > 0)?.value ?? null;
      } catch (e) {
        logger.warn('ig-session: cookie read failed', { name, error: String(e) });
        return null;
      }
    },
    async clear(): Promise<void> {
      const igSession = session.fromPartition(IG_PARTITION);
      await igSession.clearStorageData();
      await igSession.clearCache();
    },
  };
}
