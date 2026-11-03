/**
 * The startup steps (spec §12.8): open-own-profile (today's landing), confirm-account (passive identity
 * strategies 1–2 only) and resume-run (a crash's running intent), and the wiring that hands them, with the
 * graph's own steps, to the boot sequence the Foundation owns.
 */

import { TabUnresponsiveError } from '@/adapter/errors';
import { usernameFromProfileUrl } from '@/adapter/identity';
import { SURFACE } from '@/adapter/ig-surface';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { RUNTIME_BOUNDS } from '@/kernel/runtime-bounds';
import { BootSequencer, type OpenResult } from '@/main/modules/boot-sequencer';
import type { GraphSession } from '@/main/modules/session';
import { bootContributors, type ConfirmedAccount, type StatusContributor } from '@/main/modules/status-compose';
import type { IgSessionPort } from '@/main/services/ig-session';
import type { RuntimeCoordinator } from '@/main/services/runtime-coordinator';
import type { TabLease } from '@/main/services/tab-lease';
import type { TabActivity } from '@/main/tab-activity';
import type { StartupStep } from '@/shared/boot';
import { classifyOpenError } from '@/store/open-error';
import { ADAPTER } from '@/timing/config';
import { pauseBeforePageRetry } from '@/timing/page-pacing';
import { sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';

export type { StartupStep };

export interface StartupDeps {
  runtime: Pick<RuntimeCoordinator, 'ready' | 'wantsRun' | 'token' | 'snapshot' | 'record'>;
  session: Pick<GraphSession, 'current' | 'rebuildWith'>;
  tab: Pick<InstagramTab, 'currentUrl'>;
  /** Identity strategies 1–2 only: no navigation, no press. */
  readOwnUsernamePassively(signal: AbortSignal): Promise<string | undefined>;
  /** Today's landing press on the nav profile link. */
  clickOwnProfileLink(): Promise<boolean>;
  withHold<T>(name: 'open-profile' | 'startup', run: () => Promise<T>): Promise<T>;
  readCookie(): Promise<string | null>;
  block(reason: string): void;
  startEngine(o: { automaticToken: number }): Promise<unknown>;
  setAccountConfirmed(username: string | null): void;
  tourHeld(): boolean;
  disposing(): boolean;
  /** True while a driver other than the startup sequence holds the tab. */
  tabBusy(): boolean;
}

/** Step 1, today's landing moved: press the nav profile link, then wait for a profile URL. */
export function openOwnProfileStep(d: StartupDeps): StartupStep {
  return {
    name: 'open-own-profile',
    when: () => d.session.current() !== null && d.runtime.ready() && !d.tourHeld(),
    run: async (signal) => {
      const target = d.session.current()?.ownUsername ?? null;
      const here = (): string | null => usernameFromProfileUrl(d.tab.currentUrl());
      const start = here();
      if (start !== null && (target === null || start === target)) return;
      await d.withHold('open-profile', async () => {
        for (let attempt = 0; attempt < RUNTIME_BOUNDS.PROFILE_LAND_CLICK_ATTEMPTS; attempt++) {
          if (d.disposing() || d.tabBusy() || signal.aborted) return;
          let clicked = false;
          try {
            clicked = await d.clickOwnProfileLink();
          } catch (e) {
            // The rail link navigates in-page; post-click uncertainty is decided by the URL.
            if (!(e instanceof TabUnresponsiveError && e.phase === 'post-click')) {
              logger.warn('foundation: profile landing click failed', { error: String(e) });
              return;
            }
            clicked = true;
          }
          if (clicked) {
            // Our own nav link was pressed, so any profile URL is ours (the stored name may be stale).
            for (let i = 0; i < ADAPTER.NAV_SETTLE_ROUNDS && !signal.aborted; i++) {
              await sleep(ADAPTER.NAV_SETTLE_MS, signal);
              if (here() !== null) return logger.info('foundation: landed on own profile', { username: here() });
            }
            logger.warn('foundation: profile click did not navigate, retrying', { attempt });
          }
          if (attempt === 0) await pauseBeforePageRetry(ADAPTER.PROFILE_LAND_RETRY_MS, signal);
        }
        logger.warn('foundation: could not land on own profile');
      });
    },
  };
}

/** Step 2: the signed-in username (the landed URL, else a passive read) against the graph's; rebuild when new. */
export function confirmAccountStep(d: StartupDeps): StartupStep {
  return {
    name: 'confirm-account',
    when: () => d.session.current() !== null,
    run: async (signal) => {
      const graph = d.session.current();
      if (graph === null) return;
      const seen = usernameFromProfileUrl(d.tab.currentUrl())
        ?? (await d.withHold('startup', () => d.readOwnUsernamePassively(signal)));
      if (seen === undefined) {
        logger.warn('boot: account confirmation inconclusive; the graph keeps its username', {
          username: graph.ownUsername ?? null,
        });
        return;
      }
      if (seen !== graph.ownUsername && !(await d.session.rebuildWith(seen))) return;
      d.setAccountConfirmed(seen);
      logger.info('boot: account confirmed', { username: seen });
    },
  };
}

/** Step 4, today's run-intent restore moved: resume a crash's running intent once the identity matches. */
export function resumeRunStep(d: StartupDeps): StartupStep {
  return {
    name: 'resume-run',
    when: () => d.runtime.wantsRun() && !d.disposing() && !d.tourHeld(),
    run: async () => {
      const token = d.runtime.token();
      const expected = d.runtime.snapshot().accountPk;
      const actual = await d.readCookie();
      if (actual === null || expected !== actual) {
        d.block(actual === null ? 'login-required' : 'account-changed');
        return;
      }
      d.runtime.record('process-recovery-start');
      await d.startEngine({ automaticToken: token });
    },
  };
}

const passiveRead = async (tab: Pick<InstagramTab, 'evaluate'>, script: string, label: string): Promise<string | null> => {
  try {
    return await tab.evaluate<string | null>(script);
  } catch (e) {
    logger.warn('boot: passive identity read failed', { label, error: String(e) });
    return null;
  }
};

/** Identity strategies 1–2: the nav profile link's href, then the avatar's alt text — two reads, no press. */
export async function readOwnUsernamePassively(
  tab: Pick<InstagramTab, 'evaluate'>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  const href = await passiveRead(tab, SURFACE.readProfileHrefScript(), 'profile-href');
  const fromHref = href ? SURFACE.usernameFromProfileUrl(href) : null;
  if (fromHref !== null || signal.aborted) return fromHref ?? undefined;
  const alt = await passiveRead(tab, SURFACE.readAvatarAltScript(), 'avatar-alt');
  const fromAlt = alt ? SURFACE.usernameFromAvatarAlt(alt) : null;
  return fromAlt && SURFACE.usernameFromProfileUrl(`/${fromAlt}/`) ? fromAlt : undefined;
}

/** What the Foundation hands the startup wiring. */
export interface StartupWiring {
  tab: InstagramTab;
  runtime: RuntimeCoordinator;
  lease: TabLease;
  activity: TabActivity;
  session: GraphSession;
  igSession: IgSessionPort;
  tabFirstLoad: Promise<'ready' | 'failed'>;
  disposing(): boolean;
  blockRuntime(reason: string): void;
  startEngine(o: { automaticToken: number }): Promise<unknown>;
  /** True while a manual op or the engine drives the tab. */
  driverBusy(): boolean;
  pushStatus(): void;
  /** Runs whenever the startup lease is released (the seed check's tab slot). */
  afterStartup?(): void;
}

/** R2 + R3: the store-first open, its failure classified (never thrown). */
async function openData(session: GraphSession): Promise<OpenResult> {
  try {
    return (await session.openFromStore()) ? { kind: 'open' } : { kind: 'signed-out' };
  } catch (error) {
    return { kind: 'failed', problem: classifyOpenError(error), detail: String(error) };
  }
}

/** The boot sequence over the Foundation's parts, and the graph-independent `boot` / `account` contributors. */
export function createStartup(w: StartupWiring): { boot: BootSequencer; contributors: readonly StatusContributor[] } {
  let confirmed: ConfirmedAccount | null = null;
  const deps: StartupDeps = {
    runtime: w.runtime, session: w.session, tab: w.tab,
    readOwnUsernamePassively: (signal) => readOwnUsernamePassively(w.tab, signal),
    clickOwnProfileLink: async () => (await w.session.current()?.actor.clickOwnProfileLink()) ?? false,
    withHold: (name, run) => w.activity.with(name, run),
    readCookie: () => w.igSession.readCookie('ds_user_id'),
    block: (reason) => w.blockRuntime(reason),
    startEngine: (o) => w.startEngine(o),
    setAccountConfirmed: (username) => {
      const graph = w.session.current();
      confirmed = username === null || graph === null ? null : { pk: graph.ownPk, username };
    },
    tourHeld: () => w.lease.tourHeld(),
    disposing: () => w.disposing(),
    tabBusy: () => w.driverBusy() || (w.lease.owner() !== null && w.lease.owner() !== 'startup'),
  };
  const resume = resumeRunStep(deps);
  const boot = new BootSequencer({
    clock: { now: () => Date.now() },
    after: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    openData: () => openData(w.session),
    tabFirstLoad: w.tabFirstLoad,
    retryTabLoad: () => w.tab.goto(IG_HOME_URL).then(() => 'ready' as const, (error: unknown) => {
      logger.warn('boot: home reload failed', { error: String(error) });
      return 'failed' as const;
    }),
    claimStartup: () => {
      if (w.driverBusy() || w.lease.owner() !== null) return null;
      const generation = w.lease.claim('startup');
      return () => w.lease.release('startup', generation);
    },
    tourHeld: () => w.lease.tourHeld(),
    onTourReleased: (cb) => w.lease.onTourReleased(cb),
    pushStatus: () => w.pushStatus(),
    identitySteps: [openOwnProfileStep(deps), confirmAccountStep(deps)],
    laterSteps: () => [...(w.session.current()?.startupSteps ?? []), resume],
    afterStartup: () => w.afterStartup?.(),
  });
  return { boot, contributors: bootContributors({ boot: () => boot.view(), confirmed: () => confirmed }) };
}
