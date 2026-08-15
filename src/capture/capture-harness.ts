/**
 * CaptureHarness — the engine of the Task E capture app.
 *
 * It attaches to a live, logged-in `InstagramTab` and passively records the RAW
 * Instagram JSON API responses and DOM structures that Tasks 7-8 (Reader /
 * Actor / Sentinel) will be built and tested against. It deliberately depends on
 * NOTHING that is not yet built — no Reader, no Adapter, no Store. It captures
 * raw bytes and raw HTML and writes an inventory, and a maintainer distils the
 * versioned surface module (`src/adapter/versions/*`) from its output later.
 *
 * Everything here is defensive: the response handler must NEVER throw out of the
 * tab's CDP callback (that would poison the observer), so every branch logs and
 * continues. Bodies are fetched PROMPTLY (awaited immediately) because CDP evicts
 * response bodies after navigation.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { classify, isInterestingJson, type Classification } from '@/capture/classify';
import { SURFACE } from '@/adapter/ig-surface';
import * as logger from '@/utils/logger';
import type { InstagramTab } from '@/adapter/tab';
import type { TabResponse, Unsubscribe } from '@/types';
import { sleep } from '@/timing/primitives';
import { HARNESS } from '@/timing/config';

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

/** Instagram web app id — required header for the private JSON API. */
const IG_APP_ID = SURFACE.appId;

/** Max bodies persisted per classification; observations beyond this are counted only. */
const MAX_SAVED_PER_CLASS = 10;

/** How often the harness sweeps for a newly-opened `[role="dialog"]`. */
const DIALOG_SWEEP_MS = HARNESS.DIALOG_SWEEP_MS;

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

  /**
   * Persist a parsed body captured DIRECTLY (not via the passive observer) and
   * record it in the manifest. Used by {@link captureProfileShapes} for the
   * shapes that Instagram will not fire on its own (web_profile_info via the
   * page's own session, and the single `friendships/show/<pk>/` endpoint).
   * Deterministic captures always write (they bypass MAX_SAVED_PER_CLASS).
   */
  private saveRaw(
    classification: Classification,
    parsed: unknown,
    url: string,
    status: number,
  ): string | null {
    const seq = ++this.seq;
    const name = `${String(seq).padStart(4, '0')}-${classification}.json`;
    let file: string | null = null;
    try {
      writeFileSync(
        path.join(this.rawDir, name),
        JSON.stringify(parsed, null, 2),
        'utf8',
      );
      file = path.join('raw', name);
      this.savedPerClass.set(
        classification,
        (this.savedPerClass.get(classification) ?? 0) + 1,
      );
      logger.info('capture.saved body (direct)', { classification, file, url });
    } catch (e) {
      logger.error('capture.write body failed (direct)', {
        url,
        error: String(e),
      });
    }
    this.manifest.push({
      seq,
      url,
      status,
      classification,
      file,
      at: Date.now(),
    });
    return file;
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

  /**
   * Save the profile header (`<header>`) if present, falling back to `<main>`'s
   * first section when Instagram has not rendered a `<header>`. When a username
   * is given the snapshot is named `profile-header-<username>` so per-account
   * headers (with their Follow/Following/Unfollow button) are distinguishable.
   */
  async snapshotHeader(username?: string): Promise<void> {
    let html = await this.captureOuterHtml('header');
    if (!html) html = await this.captureOuterHtml('main section');
    const name = username ? `profile-header-${username}` : 'header';
    if (html) this.writeDom(name, html);
    else
      logger.warn('capture.snapshotHeader: no <header> or <main> section found', {
        username: username ?? null,
      });
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
        var id = '__epo_capture_banner';
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
        var title = ${JSON.stringify(`Epo capture: ${text}`)};
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
      "If the followers list didn't open on its own, click the followers count yourself — capture continues.";

    // (a) Profile
    await this.setStatus('Capturing profile…', `target: @${target}`);
    await this.tab.goto(`https://www.instagram.com/${target}/`);
    await sleep(HARNESS.CAPTURE_NAV_SETTLE_MS);
    await this.snapshotHeader();

    // (b) Followers dialog
    await this.setStatus('Opening followers…', FALLBACK);
    await this.tab.goto(`https://www.instagram.com/${target}/followers/`);
    await sleep(HARNESS.CAPTURE_NAV_SETTLE_MS);
    await this.snapshotDialog();

    // (c) Scroll follower pages to trigger paginated fetches.
    for (let i = 1; i <= 8; i++) {
      await this.setStatus(
        `Scrolling follower pages… (${i}/8)`,
        FALLBACK,
      );
      await this.scrollFollowersDialog();
      await sleep(HARNESS.CAPTURE_DIALOG_SETTLE_MS);
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
   * Deterministically capture the three shapes the passive-only flow misses for
   * each sample username: (1) web_profile_info (follower/following COUNTS),
   * (2) the profile HEADER DOM (where the Follow/Following/Unfollow button
   * lives), and (3) the single `friendships/show/<pk>/` shape (returns BOTH
   * `following` and `followed_by`, unlike show_many). Every step is best-effort:
   * a failure is logged and the flow continues to the next sample.
   */
  async captureProfileShapes(samples: string[]): Promise<void> {
    for (const u of samples) {
      try {
        await this.captureOneProfileShape(u);
      } catch (e) {
        logger.error('capture.captureProfileShapes: sample failed', {
          username: u,
          error: String(e),
        });
      }
      await sleep(HARNESS.CAPTURE_SHORT_SETTLE_MS);
    }
  }

  private async captureOneProfileShape(u: string): Promise<void> {
    await this.setStatus(`Capturing profile shape for @${u}…`);
    const uJson = JSON.stringify(u);

    // (1) web_profile_info via the page's own session (same technique as
    //     detectOwnUsername). May fail with "useragent mismatch" — that's fine;
    //     the profile NAVIGATION in step (2) makes Instagram fire its own count
    //     queries which passive capture saves regardless.
    let pk: string | null = null;
    try {
      const wpiUrl =
        `/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`;
      const data = await this.tab.evaluate<Record<string, unknown> | null>(
        `fetch('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(${uJson}), { headers: { 'x-ig-app-id': '${IG_APP_ID}' }, credentials: 'include' })
          .then(function(r){ return r.json(); })
          .catch(function(){ return null; })`,
      );
      const user = extractProfileUser(data);
      if (user) {
        this.saveRaw('profile-info', data, wpiUrl, 200);
        pk = extractPk(user);
      } else {
        logger.warn('capture.captureProfileShapes: web_profile_info had no user', {
          username: u,
        });
      }
    } catch (e) {
      logger.warn('capture.captureProfileShapes: web_profile_info fetch failed', {
        username: u,
        error: String(e),
      });
    }

    // (2) Navigate to the profile so Instagram fires its own profile/count
    //     queries (passively captured), then snapshot the header DOM.
    try {
      await this.tab.goto(`https://www.instagram.com/${u}/`);
      await sleep(HARNESS.CAPTURE_NAV_SETTLE_MS);
      await this.snapshotHeader(u);
    } catch (e) {
      logger.warn('capture.captureProfileShapes: profile navigation failed', {
        username: u,
        error: String(e),
      });
    }

    // (3) Single friendships/show/<pk>/ — the only shape with `followed_by`.
    if (pk) {
      try {
        const showUrl = `/api/v1/friendships/show/${pk}/`;
        const show = await this.tab.evaluate<Record<string, unknown> | null>(
          `fetch(${JSON.stringify(showUrl)}, { headers: { 'x-ig-app-id': '${IG_APP_ID}' }, credentials: 'include' })
            .then(function(r){ return r.json(); })
            .catch(function(){ return null; })`,
        );
        if (
          show &&
          ('following' in show || 'followed_by' in show || show.status === 'ok')
        ) {
          this.saveRaw('friendship-show', show, showUrl, 200);
        } else {
          logger.warn(
            'capture.captureProfileShapes: friendships/show had no relationship fields',
            { username: u, pk },
          );
        }
      } catch (e) {
        logger.warn('capture.captureProfileShapes: friendships/show fetch failed', {
          username: u,
          pk,
          error: String(e),
        });
      }
    } else {
      logger.warn(
        'capture.captureProfileShapes: no pk resolved; skipping friendships/show',
        { username: u },
      );
    }
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
   * into a `src/adapter/versions/*` surface module later.
   */
  writeDraftNotes(): void {
    const counts = this.countsByClass();
    const savedRaw = this.manifest.filter((e) => e.file);
    const lines: string[] = [];

    lines.push('# Epo Adapter — Field Notes (DRAFT / auto-generated)');
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

    lines.push('## TODO — Endpoints (distil into src/adapter/versions/*)');
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

/** Narrow an unknown value to a plain object, else null. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object'
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Pull the `user` object out of a web_profile_info body. The private API wraps
 * it as `{ data: { user } }`; some variants expose `{ user }` at the top level.
 */
function extractProfileUser(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) return null;
  const nested = asRecord(root.data);
  return (nested && asRecord(nested.user)) ?? asRecord(root.user);
}

/** Extract the numeric pk (as a string) from a user object, if present. */
function extractPk(user: Record<string, unknown>): string | null {
  for (const key of ['id', 'pk', 'pk_id']) {
    const v = user[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}
