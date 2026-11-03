/**
 * Startup steps: the own-profile landing and the run-intent restore, each a
 * named step with a predicate for when it applies. The Foundation runs them.
 */

import { TabUnresponsiveError } from '@/adapter/errors';
import { usernameFromProfileUrl } from '@/adapter/identity';
import type { InstagramTab } from '@/adapter/tab';
import type { BuiltGraph } from '@/main/services/graph-types';
import type { IgSessionPort } from '@/main/services/ig-session';
import type { RuntimeCoordinator } from '@/main/services/runtime-coordinator';
import type { TabLease } from '@/main/services/tab-lease';
import type { TabActivity } from '@/main/tab-activity';
import type { StartupStep } from '@/shared/boot';
import { ADAPTER } from '@/timing/config';
import { pauseBeforePageRetry } from '@/timing/page-pacing';
import { sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';

export type { StartupStep };

/** Run `step` when it applies; `signal` interrupts its waits. */
export async function runStep(step: StartupStep, signal: AbortSignal): Promise<void> {
  if (step.when()) await step.run(signal);
}

export interface LandingStepDeps {
  tab: InstagramTab;
  runtime: RuntimeCoordinator;
  lease: TabLease;
  activity: TabActivity;
  /** True once the Foundation began disposing. */
  disposing(): boolean;
  /** Build the graph if logged in; true when it exists. */
  ensureBuilt(): Promise<boolean>;
  /** The live graph, or `null` while the session is closed. */
  graph(): BuiltGraph | null;
}

/**
 * Land the tab on the user's OWN profile — the app's default page. Waits for
 * the lazy graph (i.e. a logged-in session) within a bounded poll, then runs
 * as a proper tracked activity: the Actor locates the nav profile-avatar
 * link and the Interactor moves the cursor to it and clicks with native
 * input events (an in-page `a.click()` is ignored by the SPA — verified
 * live), retrying once. Fire-and-forget from startup/login; every failure
 * mode resolves quietly (a cosmetic landing must never break startup).
 */
export function landingStep(d: LandingStepDeps): StartupStep {
  return {
    name: 'open-own-profile',
    when: () => d.runtime.ready(),
    run: async (signal) => {
      // Intro tour on screen: the landing (a build + a cursor-driven click) is
      // exactly the kind of self-starting work the hold parks. Remember it was
      // requested; setTourHold(false) runs it.
      if (d.lease.tourHeld()) {
        d.lease.deferProfileLanding();
        return;
      }
      // Bounded graph retry; builds may navigate, so space each attempt afresh.
      for (let i = 0; i < ADAPTER.PROFILE_LAND_ATTEMPTS; i++) {
        if (d.disposing()) return;
        if (await d.ensureBuilt()) break;
        if (i === ADAPTER.PROFILE_LAND_ATTEMPTS - 1) {
          logger.info('foundation: not logged in, profile landing skipped');
          return;
        }
        await pauseBeforePageRetry(ADAPTER.PROFILE_LAND_RETRY_MS, signal);
      }
      const graph = d.graph();
      if (graph === null || d.disposing()) return;
      // Never contend with an active driver for the tab.
      if (d.lease.owner() !== null) return;

      const target = graph.ownUsername ?? null;
      const onProfile = (): boolean => {
        const u = usernameFromProfileUrl(d.tab.currentUrl());
        return u !== null && (target === null || u === target);
      };
      if (onProfile()) return;

      await d.activity.with('open-profile', async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (d.disposing() || d.lease.owner() !== null) return;
          let clicked = false;
          try {
            clicked = await graph.actor.clickOwnProfileLink();
          } catch (e) {
            // The rail link navigates IN-PAGE: the route change can start before
            // the release is acknowledged, which the input queue reports as
            // post-click UNCERTAINTY (live 2026-10-08). The URL decides, as for
            // any click; every other failure ends the landing.
            if (!(e instanceof TabUnresponsiveError && e.phase === 'post-click')) {
              logger.warn('foundation: profile landing click failed', { error: String(e) });
              return;
            }
            clicked = true;
          }
          if (clicked) {
            for (let i = 0; i < ADAPTER.NAV_SETTLE_ROUNDS; i++) {
              await sleep(ADAPTER.NAV_SETTLE_MS, signal);
              if (onProfile()) {
                logger.info('foundation: landed on own profile', { username: target });
                return;
              }
            }
            logger.warn('foundation: profile click did not navigate, retrying', { attempt });
          }
          // The URL poll stays exact; only another page attempt gets a fresh beat.
          if (attempt === 0) await pauseBeforePageRetry(ADAPTER.PROFILE_LAND_RETRY_MS, signal);
        }
        logger.warn('foundation: could not land on own profile');
      });
    },
  };
}

export interface ResumeStepDeps {
  runtime: RuntimeCoordinator;
  lease: TabLease;
  igSession: IgSessionPort;
  /** True once the Foundation began disposing. */
  disposing(): boolean;
  /** Block the run intent with a visible reason. */
  blockRuntime(reason: string): void;
  /** Start growth under an automatic run token. */
  startEngine(opts: { automaticToken: number }): Promise<unknown>;
}

/** Resume a running intent a crash left behind, after the identity matches. */
export function resumeStep(d: ResumeStepDeps): StartupStep {
  return {
    name: 'resume-run',
    when: () => d.runtime.wantsRun() && !d.disposing() && !d.lease.tourHeld(),
    run: async () => {
      const token = d.runtime.token();
      const expected = d.runtime.snapshot().accountPk;
      const actual = await d.igSession.readCookie('ds_user_id');
      if (actual === null || expected !== actual) {
        d.blockRuntime(actual === null ? 'login-required' : 'account-changed');
        return;
      }
      d.runtime.record('process-recovery-start');
      await d.startEngine({ automaticToken: token });
    },
  };
}
