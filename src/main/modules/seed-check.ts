/**
 * The seed precheck: one sentinel-gated profile VISIT through the shared tab
 * that tells whether a seed exists and whether its followers are visible.
 */

import type { BuiltGraph } from '@/main/services/graph-types';
import type { TabActivity } from '@/main/tab-activity';
import type { SeedCheck } from '@/types';
import * as logger from '@/utils/logger';

export interface SeedCheckDeps {
  /** The veil's hold registry (the visit holds `seed-check`). */
  activity: TabActivity;
  /** Track the op so teardown drains it before closing the store. */
  trackManualOp<T>(run: () => Promise<T>): Promise<T>;
  /** Ensure the graph is built and hand it back (`null` when not logged in). */
  builtGraph(): Promise<BuiltGraph | null>;
  /** Why a manual op may not touch the tab now (R3), or `null`. */
  busyDriverReason(): string | null;
  /** Mark the manual driver busy or free. */
  setManualDriving(on: boolean): void;
  /** Restart growth when the user still wants it running. */
  resumeDesiredRun(): void;
}

export class SeedCheckService {
  constructor(private readonly deps: SeedCheckDeps) {}

  /**
   * One-shot read-only precheck of a seed username: whether it exists and whether
   * its followers list is visible (public, or private and followed). One profile
   * VISIT through the shared tab, sentinel-gated. Never throws across IPC.
   */
  async checkSeed(username: string): Promise<SeedCheck> {
    // Veil: the seed check is a real profile visit — reading counts.
    return this.deps.trackManualOp(() =>
      this.deps.activity.with('seed-check', () => this.checkSeedHeld(username)),
    );
  }

  private async checkSeedHeld(username: string): Promise<SeedCheck> {
    const graph = await this.deps.builtGraph();
    if (graph === null) {
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'not-logged-in' };
    }
    // R3: refuse while a driver runs — a concurrent one-shot fetch competes with
    // that driver's own IG traffic and its sentinel gating.
    const busy = this.deps.busyDriverReason();
    if (busy !== null) {
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: busy };
    }
    this.deps.setManualDriving(true);
    try {
      const clean = username.trim().replace(/^@/, '');
      if (!clean) return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'empty' };
      if ((await graph.sentinel.check()) !== 'ok') {
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'blocked' };
      }
      // One profile VISIT (`rim/profile-visit.ts`): the page's own client reads
      // the profile and the observer has stored it — FACTS STREAM (PRINCIPLES
      // §1) — by the time this resolves, adopted seed or not.
      const visit = await graph.profiles.visit(clean);
      if (!visit.ok) {
        // A wall is IG blocking; `gone` is the page saying the profile is not
        // available; a page that never answered is unknown, never "not found".
        const reason =
          visit.kind === 'walled' ? 'blocked' : visit.kind === 'gone' ? 'not-found' : 'error';
        logger.warn('foundation.checkSeed: profile visit failed', { kind: visit.kind, reason, ...visit.detail });
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason };
      }
      const isPrivate = visit.obs.fields.isPrivate === true;
      // A private account's followers are viewable iff we follow it. The
      // profile body carries the viewer-side flags, so a private seed no longer
      // costs a `friendships/show` read (same rule as before: follow or request).
      const followersVisible = isPrivate
        ? visit.viewer.following === true || visit.viewer.requested === true
        : true;
      return {
        ok: true,
        exists: true,
        followersVisible,
        isPrivate,
        reason: followersVisible ? undefined : 'private',
      };
    } catch (e) {
      // Only a genuinely unexpected exception (evaluate/tab failure) lands here.
      logger.error('foundation.checkSeed: failed', { username, error: String(e) });
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'error' };
    } finally {
      this.deps.setManualDriving(false);
      this.deps.resumeDesiredRun();
    }
  }
}
