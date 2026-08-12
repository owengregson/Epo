/**
 * Sentinel — block / challenge / logged-out detection.
 *
 * Before (and around) any action, the engine asks the Sentinel whether the tab
 * is in a safe state. URL checks are the most reliable signal (Instagram
 * redirects to `/challenge/`, `/accounts/suspended/`, `/accounts/login/`); a
 * body-text scan is a best-effort backstop for in-page "Action Blocked" style
 * interstitials that do not change the URL.
 *
 * All signatures live in `field-notes.ts`; this file only maps a match to a
 * label. Any non-`ok` result should halt the engine and alert.
 */

import * as logger from '@/utils/logger';
import { BLOCK_SIGNATURES } from '@/adapter/field-notes';

export type SentinelStatus = 'ok' | 'action-blocked' | 'challenge' | 'logged-out';

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
    const text = await this.tab.evaluate<string>(
      `(() => (document.body ? document.body.innerText : ''))()`,
    );
    for (const rx of BLOCK_SIGNATURES.texts) {
      if (rx.test(text)) {
        logger.warn('sentinel.blocked', { by: 'text', pattern: String(rx) });
        return 'action-blocked';
      }
    }

    return 'ok';
  }

  /**
   * Map a URL against `BLOCK_SIGNATURES.urls`. The login redirect means the
   * session expired (`logged-out`); `/challenge/` and `/accounts/suspended/`
   * are account interstitials (`challenge`).
   */
  private classifyUrl(url: string): SentinelStatus {
    const [challengeRx, suspendedRx, loginRx] = BLOCK_SIGNATURES.urls;
    if (loginRx.test(url)) return 'logged-out';
    if (challengeRx.test(url) || suspendedRx.test(url)) return 'challenge';
    return 'ok';
  }
}
