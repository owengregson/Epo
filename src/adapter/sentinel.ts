/**
 * Sentinel — block / challenge / logged-out detection.
 *
 * Before (and around) any action, the engine asks the Sentinel whether the tab
 * is in a safe state. URL checks are the most reliable signal (Instagram
 * redirects to challenge/suspended/login interstitials); a body-text scan is a
 * best-effort backstop for in-page "Action Blocked" style interstitials that
 * do not change the URL.
 *
 * All signatures live in the active `SURFACE` version module as LABELLED
 * `BlockSignature`s (pattern → status), so this file is version-agnostic and
 * only walks the tables. Any non-`ok` result should halt the engine and alert.
 */

import * as logger from '@/utils/logger';
import { SURFACE } from '@/adapter/ig-surface';
import type { SentinelStatus } from '@/adapter/ig-surface';

// Re-export so existing consumers keep importing the status from here.
export type { SentinelStatus } from '@/adapter/ig-surface';

/** Minimal structural view of the tab the Sentinel inspects. */
export interface SentinelTab {
  evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T>;
  currentUrl(): string;
}

export class Sentinel {
  private readonly tab: SentinelTab;

  constructor(tab: SentinelTab) {
    this.tab = tab;
  }

  /**
   * Classify the tab's current state. URL is checked first (most reliable),
   * then the page body text. Returns `ok` when nothing matches.
   */
  async check(): Promise<SentinelStatus> {
    const url = this.tab.currentUrl();
    const urlStatus = this.classifyUrl(url);
    if (urlStatus !== 'ok') {
      logger.warn('sentinel.blocked', { by: 'url', url, status: urlStatus });
      return urlStatus;
    }

    // Body-text backstop: a challenge/block screen that keeps the same URL.
    const text = await this.tab.evaluate<string>(SURFACE.bodyTextProbeScript());
    for (const sig of SURFACE.textSignatures) {
      if (sig.pattern.test(text)) {
        logger.warn('sentinel.blocked', { by: 'text', pattern: String(sig.pattern) });
        return sig.status;
      }
    }

    return 'ok';
  }

  /** Map a URL against the labelled block signatures. */
  private classifyUrl(url: string): SentinelStatus {
    for (const sig of SURFACE.blockSignatures) {
      if (sig.pattern.test(url)) return sig.status;
    }
    return 'ok';
  }
}
