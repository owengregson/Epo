/**
 * CaptureHarness — the engine of the Task E capture app.
 *
 * It attaches to a live, logged-in `InstagramTab` and passively records the RAW
 * Instagram JSON API responses and DOM structures that Tasks 7-8 (Reader /
 * Actor / Sentinel) will be built and tested against. It deliberately depends on
 * NOTHING that is not yet built — no Reader, no Adapter, no Store. It captures
 * raw bytes and raw HTML and writes an inventory, and a human distils the real
 * `field-notes.ts` from its output later.
 *
 * Everything here is defensive: the response handler must NEVER throw out of the
 * tab's CDP callback (that would poison the observer), so every branch logs and
 * continues. Bodies are fetched PROMPTLY (awaited immediately) because CDP evicts
 * response bodies after navigation.
 */

import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import { classify, isInterestingJson, type Classification } from '@/capture/classify';
import * as logger from '@/utils/logger';
import type { InstagramTab } from '@/adapter/tab';
import type { TabResponse, Unsubscribe } from '@/types';

/** One recorded response in the capture manifest. */
export interface ManifestEntry {
  seq: number;
  url: string;
  status: number;
  classification: Classification;
  /** Relative path of the saved body, or null when the body was not saved. */
  file: string | null;
  at: number;
}

/** Snapshot record for a saved DOM fragment. */
export interface DomSnapshotEntry {
  name: string;
  seq: number;
  file: string;
  at: number;
}

/** Max bodies persisted per classification; observations beyond this are counted only. */
const MAX_SAVED_PER_CLASS = 10;

/** How often the harness sweeps for a newly-opened `[role="dialog"]`. */
const DIALOG_SWEEP_MS = 2000;

export class CaptureHarness {
  private readonly tab: InstagramTab;
  private readonly outDir: string;
  private readonly rawDir: string;
  private readonly domDir: string;

  private readonly manifest: ManifestEntry[] = [];
  private readonly domSnapshots: DomSnapshotEntry[] = [];
  private readonly savedPerClass = new Map<Classification, number>();

  private seq = 0;
  private domSeq = 0;
  private lastDialogText = '';
  private lastStatus = '';

  private unsubscribeResponses: Unsubscribe | null = null;
  private dialogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(tab: InstagramTab, outDir: string) {
    this.tab = tab;
    this.outDir = outDir;
    this.rawDir = path.join(outDir, 'raw');
    this.domDir = path.join(outDir, 'dom');
    mkdirSync(this.rawDir, { recursive: true });
    mkdirSync(this.domDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Passive capture
  // -------------------------------------------------------------------------

  /** Begin observing network responses + periodic dialog sweeps. Idempotent-ish. */
  start(): void {
    if (this.unsubscribeResponses) return;
    this.unsubscribeResponses = this.tab.onResponse((res) => {
      // The handler is invoked synchronously from the CDP callback; kick the
      // async body fetch but never let a rejection escape.
      void this.handleResponse(res);
    });
    this.dialogTimer = setInterval(() => {
      void this.snapshotAnyDialog();
    }, DIALOG_SWEEP_MS);
    logger.info('capture.harness started', { outDir: this.outDir });
  }

  /** Stop the periodic dialog sweep and detach the response observer. */
  stop(): void {
    if (this.dialogTimer) {
      clearInterval(this.dialogTimer);
      this.dialogTimer = null;
    }
    if (this.unsubscribeResponses) {
      this.unsubscribeResponses();
      this.unsubscribeResponses = null;
    }
  }

  private async handleResponse(res: TabResponse): Promise<void> {
    try {
      if (!isInterestingJson(res.url, res.mimeType)) return;

      const classification = classify(res.url);
      const seq = ++this.seq;

      // Fetch the body PROMPTLY — CDP can evict it after navigation.
      let body: string;
      try {
        body = await res.getBody();
      } catch (e) {
        logger.warn('capture.getBody failed (body likely evicted)', {
          url: res.url,
          error: String(e),
        });
        this.manifest.push({
          seq,
          url: res.url,
          status: res.status,
          classification,
          file: null,
          at: Date.now(),
        });
        return;
      }

      // Only save bodies that actually parse as JSON.
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        logger.debug('capture.skip non-JSON body', {
          url: res.url,
          error: String(e),
        });
        return;
      }

      const savedSoFar = this.savedPerClass.get(classification) ?? 0;
      let file: string | null = null;
      if (savedSoFar < MAX_SAVED_PER_CLASS) {
        const name = `${String(seq).padStart(4, '0')}-${classification}.json`;
        try {
          writeFileSync(
            path.join(this.rawDir, name),
            JSON.stringify(parsed, null, 2),
            'utf8',
          );
          file = path.join('raw', name);
          this.savedPerClass.set(classification, savedSoFar + 1);
          logger.info('capture.saved body', { classification, file, url: res.url });
        } catch (e) {
          logger.error('capture.write body failed', {
            url: res.url,
            error: String(e),
          });
        }
      } else {
        logger.debug('capture.body observed (cap reached, counting only)', {
          classification,
          url: res.url,
        });
      }

      this.manifest.push({
        seq,
        url: res.url,
        status: res.status,
        classification,
        file,
        at: Date.now(),
      });
    } catch (e) {
      // Absolutely never throw out of the response handler.
      logger.error('capture.handleResponse unexpected error', {
        url: res.url,
        error: String(e),
      });
    }
  }

  // -------------------------------------------------------------------------
  // DOM snapshots
  // -------------------------------------------------------------------------

  private async captureOuterHtml(selector: string): Promise<string | null> {
    try {
      return await this.tab.evaluate<string | null>(
        `(() => { const el = document.querySelector(${JSON.stringify(
          selector,
        )}); return el ? el.outerHTML : null; })()`,
      );
    } catch (e) {
      logger.warn('capture.evaluate outerHTML failed', {
        selector,
        error: String(e),
      });
      return null;
    }
  }

  private writeDom(name: string, html: string): void {
    const seq = ++this.domSeq;
    const file = `${name}-${String(seq).padStart(3, '0')}.html`;
    try {
      writeFileSync(path.join(this.domDir, file), html, 'utf8');
      this.domSnapshots.push({
        name,
        seq,
        file: path.join('dom', file),
        at: Date.now(),
      });
      logger.info('capture.saved dom', { name, file });
    } catch (e) {
      logger.error('capture.write dom failed', { name, error: String(e) });
    }
  }

  /** Save the profile header (`<header>`) if present. */
  async snapshotHeader(): Promise<void> {
    const html = await this.captureOuterHtml('header');
    if (html) this.writeDom('header', html);
    else logger.warn('capture.snapshotHeader: no <header> found');
  }

  /** Save the first `[role="dialog"]` (e.g. the followers dialog) if present. */
  async snapshotDialog(): Promise<void> {
    const html = await this.captureOuterHtml('[role="dialog"]');
    if (html) this.writeDom('dialog', html);
    else logger.warn('capture.snapshotDialog: no [role="dialog"] found');
  }

  /**
   * Save a `[role="dialog"]` only when its text content differs from the last
   * saved dialog. Runs on an interval so manually-opened dialogs (e.g. the
   * unfollow-confirm) get captured without any orchestration.
   */
  async snapshotAnyDialog(): Promise<void> {
    let probe: { html: string; text: string } | null;
    try {
      probe = await this.tab.evaluate<{ html: string; text: string } | null>(
        `(() => { const el = document.querySelector('[role="dialog"]'); return el ? { html: el.outerHTML, text: (el.textContent || '').trim() } : null; })()`,
      );
    } catch (e) {
      logger.warn('capture.snapshotAnyDialog evaluate failed', {
        error: String(e),
      });
      return;
    }
    if (!probe) return;
    if (probe.text === this.lastDialogText) return;
    this.lastDialogText = probe.text;
    this.writeDom('any-dialog', probe.html);
  }

  // -------------------------------------------------------------------------
  // Status banner
  // -------------------------------------------------------------------------

  /**
   * Log a status line and inject/update an unobtrusive banner at the top of the
   * IG page. Re-injects after navigations (the element is recreated if missing).
   */
  async setStatus(text: string, instruction = ''): Promise<void> {
    this.lastStatus = text;
    logger.info(`capture.status » ${text}`, instruction ? { instruction } : undefined);
    const script = `(() => {
      try {
        var id = '__peanut_capture_banner';
        var el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          el.style.cssText = [
            'position:fixed','top:0','left:0','right:0','z-index:2147483647',
            'font:600 12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
            'background:rgba(14,14,16,0.92)','color:#f5f5f7','padding:6px 12px',
            'border-bottom:1px solid #333','pointer-events:none','letter-spacing:0.2px'
          ].join(';');
          (document.body || document.documentElement).appendChild(el);
        }
        var title = ${JSON.stringify('Peanut capture: ' + text)};
        var instr = ${JSON.stringify(instruction)};
        el.innerHTML = '<span>' + title + '</span>' +
          (instr ? '<span style="opacity:0.7;font-weight:400;margin-left:10px">' + instr + '</span>' : '');
        return true;
      } catch (e) { return false; }
    })()`;
    try {
      await this.tab.evaluate<boolean>(script);
    } catch (e) {
      // Banner injection is cosmetic; the console status above is the source of truth.
      logger.warn('capture.setStatus banner injection failed', {
        error: String(e),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Orchestrated capture flow
  // -------------------------------------------------------------------------

  /**
   * Drive the core capture flow for `target`: profile → followers dialog →
   * scroll several pages. Passive capture + interval dialog snapshots keep
   * running afterwards (until the window closes) so manual steps are captured.
   */
  async driveCaptureFlow(target: string): Promise<void> {
    const FALLBACK =
      "If the followers list didn't open automatically, click the followers count yourself — capture continues.";

    // (a) Profile
    await this.setStatus('Capturing profile…', `target: @${target}`);
    await this.tab.goto(`https://www.instagram.com/${target}/`);
    await delay(4000);
    await this.snapshotHeader();

    // (b) Followers dialog
    await this.setStatus('Opening followers…', FALLBACK);
    await this.tab.goto(`https://www.instagram.com/${target}/followers/`);
    await delay(4000);
    await this.snapshotDialog();

    // (c) Scroll follower pages to trigger paginated fetches.
    for (let i = 1; i <= 8; i++) {
      await this.setStatus(
        `Scrolling follower pages… (${i}/8)`,
        FALLBACK,
      );
      await this.scrollFollowersDialog();
      await delay(2500);
    }

    // (d) Done — leave passive capture running for optional manual steps.
    await this.setStatus(
      'Core capture done — optional manual steps below.',
      'Open the unfollow-confirm dialog or the activity feed to capture more. Close the window when finished.',
    );
    // Grab a final header/dialog state in case the manual flow already changed it.
    await this.snapshotHeader();
  }

  /**
   * Scroll the followers dialog's own scrollable descendant to its bottom to
   * page in the next batch. Finds, within `[role="dialog"]`, the largest
   * element whose content overflows vertically with an auto/scroll overflowY.
   */
  private async scrollFollowersDialog(): Promise<void> {
    try {
      await this.tab.evaluate<boolean>(`(() => {
        var dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return false;
        var best = null; var bestArea = 0;
        var nodes = dialog.querySelectorAll('*');
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.scrollHeight <= n.clientHeight) continue;
          var oy = getComputedStyle(n).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') continue;
          var area = n.clientHeight * n.clientWidth;
          if (area > bestArea) { bestArea = area; best = n; }
        }
        if (!best) return false;
        best.scrollTop = best.scrollHeight;
        return true;
      })()`);
    } catch (e) {
      logger.warn('capture.scrollFollowersDialog failed', { error: String(e) });
    }
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  private countsByClass(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of this.manifest) {
      counts[e.classification] = (counts[e.classification] ?? 0) + 1;
    }
    return counts;
  }

  /** Return a snapshot of the per-classification observed counts. */
  getCounts(): Record<string, number> {
    return this.countsByClass();
  }

  /** Write `<outDir>/manifest.json`. */
  writeManifest(): void {
    const payload = {
      generatedAt: new Date().toISOString(),
      lastStatus: this.lastStatus,
      counts: this.countsByClass(),
      responses: this.manifest,
      domSnapshots: this.domSnapshots,
    };
    try {
      writeFileSync(
        path.join(this.outDir, 'manifest.json'),
        JSON.stringify(payload, null, 2),
        'utf8',
      );
      logger.info('capture.wrote manifest', {
        responses: this.manifest.length,
        domSnapshots: this.domSnapshots.length,
      });
    } catch (e) {
      logger.error('capture.write manifest failed', { error: String(e) });
    }
  }

  /**
   * Write `<outDir>/../field-notes-DRAFT.md`: an inventory scaffold with counts,
   * the raw files, the DOM snapshots, and empty TODO sections to be distilled
   * into `src/adapter/field-notes.ts` later.
   */
  writeDraftNotes(): void {
    const counts = this.countsByClass();
    const savedRaw = this.manifest.filter((e) => e.file);
    const lines: string[] = [];

    lines.push('# Peanut Adapter — Field Notes (DRAFT / auto-generated)');
    lines.push('');
    lines.push(
      '> Generated by the Task E capture harness. This is RAW inventory, not the',
    );
    lines.push(
      '> final field notes. Distil the endpoints/selectors/signatures below into',
    );
    lines.push('> `src/adapter/field-notes.ts` (Task 7) and `field-notes.md`.');
    lines.push('');
    lines.push(`- Generated: ${new Date().toISOString()}`);
    lines.push(`- Last status: ${this.lastStatus || '(none)'}`);
    lines.push('');

    lines.push('## Response inventory (counts by classification)');
    lines.push('');
    const classNames = Object.keys(counts).sort();
    if (classNames.length === 0) {
      lines.push('_No interesting JSON responses were observed._');
    } else {
      lines.push('| classification | observed |');
      lines.push('| --- | --- |');
      for (const c of classNames) lines.push(`| ${c} | ${counts[c]} |`);
    }
    lines.push('');

    lines.push('## Saved raw bodies');
    lines.push('');
    if (savedRaw.length === 0) {
      lines.push('_No bodies were saved._');
    } else {
      for (const e of savedRaw) {
        lines.push(`- \`${e.file}\` — [${e.classification}] ${e.status} ${e.url}`);
      }
    }
    lines.push('');

    lines.push('## DOM snapshots');
    lines.push('');
    if (this.domSnapshots.length === 0) {
      lines.push('_No DOM snapshots were saved._');
    } else {
      for (const d of this.domSnapshots) {
        lines.push(`- \`${d.file}\` — ${d.name}`);
      }
    }
    lines.push('');

    lines.push('## TODO — Endpoints (distil into field-notes.ts)');
    lines.push('');
    lines.push('- [ ] followers-list: URL pattern + pagination cursor in/out + JSON path to pk/username/is_private/is_verified');
    lines.push('- [ ] show-many: request batching (form vs query) + response map pk → { following, followed_by } + SHOW_MANY_MAX_BATCH');
    lines.push('- [ ] profile-info: JSON path to pk / follower_count / following_count');
    lines.push('- [ ] activity-feed: JSON path to new-follower pks');
    lines.push('');

    lines.push('## TODO — Selectors (from DOM snapshots)');
    lines.push('');
    lines.push('- [ ] Follow button (text/role)');
    lines.push('- [ ] Following button (text/role)');
    lines.push('- [ ] Unfollow confirm control (from any-dialog snapshot)');
    lines.push('- [ ] Followers dialog scroll container');
    lines.push('- [ ] Follower row structure (pk/username extraction)');
    lines.push('');

    lines.push('## TODO — Block / challenge signatures');
    lines.push('');
    lines.push('- [ ] "Action Blocked" text/markers');
    lines.push('- [ ] "Try Again Later" text/markers');
    lines.push('- [ ] Checkpoint / challenge URL + markers');
    lines.push('- [ ] Logged-out redirect markers');
    lines.push('');

    try {
      writeFileSync(
        path.join(this.outDir, '..', 'field-notes-DRAFT.md'),
        lines.join('\n'),
        'utf8',
      );
      logger.info('capture.wrote draft notes');
    } catch (e) {
      logger.error('capture.write draft notes failed', { error: String(e) });
    }
  }
}

/** Promise-based delay helper (no foreground blocking). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
