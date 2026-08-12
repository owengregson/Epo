/**
 * Request metering (R2) — make the RequestBudget reflect TRUE request volume.
 *
 * Request volume is the primary ban vector (§5), so the budget must count every
 * real Instagram API call — not just the scroll rounds we deliberately spend.
 * This subscribes to the tab's response pipeline and spends one budget token per
 * response whose URL matches a known Instagram endpoint (via `Reader.matchEndpoint`).
 * Everything else (static assets, third-party beacons) is ignored.
 *
 * The Engine installs this ONCE at startup; acquisition and every action then only
 * ever *check* `canSpend()` — they never `spend()` themselves, so the budget can't
 * be double-counted or under-counted.
 */

import type { RequestBudget } from '@/governors/request-budget';
import type { Reader } from '@/adapter/reader';
import type { RimTab } from '@/rim/types';
import * as logger from '@/utils/logger';

/**
 * Subscribe the budget to the tab's responses. Returns an unsubscribe disposer;
 * call it on teardown so the handler does not outlive the tab.
 */
export function installRequestMetering(
  tab: RimTab,
  budget: RequestBudget,
  reader: Reader,
): () => void {
  const unsubscribe = tab.onResponse((resp) => {
    // A real IG API call is any response the Reader recognizes as an endpoint.
    if (reader.matchEndpoint(resp.url) !== null) {
      budget.spend();
    }
  });
  logger.debug('rim.request-metering installed');
  return unsubscribe;
}
