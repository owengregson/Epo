/**
 * The stage controller (spec §12.4, ADR 1010): the only entry point for what covers the Instagram tab. It
 * validates, serializes (the latest request wins), enters Live through the veil curtain (a plain cut when the
 * curtain does not paint in time) and leaves Live at once. Concealment stays re-stacking (ADR 0306): the tab
 * is never hidden by native visibility. It also titles the window and badges the Dock from the posture.
 */

import type { OverlayVeil } from '@/main/overlay/veil-view';
import type { AppShell } from '@/main/window/shell';
import { derivePosture, type Posture, type PostureInput, postureHeadline } from '@/shared/posture';
import { isStageMode, type StageMode } from '@/shared/stage-mode';
import type { EpoStatus } from '@/types';
import * as logger from '@/utils/logger';

export interface StageController {
  /** Validates, serializes and curtain-reveals into Live; resolves once the request (or a later one) applied. */
  set(mode: StageMode, covered: boolean): Promise<void>;
  /** Boot: the tab under the dashboard from frame 1. */
  cover(): void;
  current(): { mode: StageMode; covered: boolean };
  /** Window title and the macOS Dock badge. */
  onPosture(p: Posture): void;
}

export interface StageControllerDeps {
  shell: Pick<AppShell, 'setStage'> & { win: Pick<AppShell['win'], 'setTitle'> };
  veil: Pick<OverlayVeil, 'curtain'>;
  /** `app.dock` on macOS, else null. */
  dock: { setBadge(text: string): void } | null;
  /** BOOT.CURTAIN_PAINT_MAX_MS and BOOT.CURTAIN_FADE_MS. */
  timing: { paintMaxMs: number; fadeMs: number };
}

/** Postures that badge the Dock (owner Q29): only what needs the user. */
const ALERT: ReadonlySet<Posture['kind']> = new Set(['needs-attention', 'data-unavailable']);
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function createStageController(d: StageControllerDeps): StageController {
  let current: { mode: StageMode; covered: boolean } = { mode: 'tab', covered: false };
  let latest: { mode: StageMode; covered: boolean } | null = null;
  let running: Promise<void> | null = null;
  let title: string | null = null;
  let badge: string | null = null;

  const live = (s: { mode: StageMode; covered: boolean }): boolean => s.mode === 'tab' && !s.covered;
  const paintedWithin = (ms: number): Promise<boolean> =>
    Promise.race([d.veil.curtain('opaque'), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

  /** One transition: into Live behind the curtain, anything else at once. */
  const apply = async (next: { mode: StageMode; covered: boolean }): Promise<void> => {
    if (next.mode === current.mode && next.covered === current.covered) return;
    const entering = live(next) && !live(current);
    current = next;
    if (!entering) return d.shell.setStage(next.mode, next.covered);
    const painted = await paintedWithin(d.timing.paintMaxMs);
    d.shell.setStage(next.mode, next.covered);
    if (painted) await d.veil.curtain('clear');
    await d.veil.curtain('off');
  };

  /** Drain requests one at a time; each round applies only the newest. */
  const drain = async (): Promise<void> => {
    while (latest !== null) {
      const next = latest;
      latest = null;
      try {
        await apply(next);
      } catch (error) {
        logger.error('stage: transition failed', { mode: next.mode, error: String(error) });
      }
    }
    running = null;
  };

  return {
    set(mode, covered) {
      if (!isStageMode(mode)) {
        logger.warn('stage: unknown mode refused', { mode: String(mode) });
        return Promise.resolve();
      }
      latest = { mode, covered };
      running ??= drain();
      return running;
    },
    cover() {
      current = { mode: 'tab', covered: true };
      d.shell.setStage('tab', true);
    },
    current: () => ({ ...current }),
    onPosture(p) {
      const resting = p.kind === 'resting' && p.countdown !== null ? ` until ${TIME.format(p.countdown.to)}` : '';
      const nextTitle = `Epo — ${postureHeadline(p.kind)}${resting}`;
      if (nextTitle !== title) {
        title = nextTitle;
        d.shell.win.setTitle(nextTitle);
      }
      const nextBadge = ALERT.has(p.kind) ? '!' : '';
      if (nextBadge !== badge) {
        badge = nextBadge;
        d.dock?.setBadge(nextBadge);
      }
    },
  };
}

/** The posture inputs main can read from one composed status (the renderer adds its own signals). */
export function postureOfStatus(s: EpoStatus): PostureInput {
  return {
    boot: s.boot ? { phase: s.boot.phase, identity: s.boot.identity, data: s.boot.data, startup: s.boot.startup } : null,
    status: {
      basis: s.basis, loggedIn: s.loggedIn, state: s.state, online: s.online, haltReason: s.haltReason,
      parkReason: s.parkReason ?? null, parkedUntil: s.parkedUntil ?? null, nextActionAt: s.nextActionAt,
      lastActionAt: s.lastActionAt, hasStepped: s.lastStep !== null,
      recovery: s.recovery === null ? null : { phase: s.recovery.phase, resumeAt: s.recovery.resumeAt },
      runtime: s.runtime === undefined ? null
        : { desired: s.runtime.desired, phase: s.runtime.phase, blockedReason: s.runtime.blockedReason },
    },
    prune: null,
    plan: null,
    catchUpRunning: s.catchUp?.state === 'running',
    boost: s.boost?.state ?? 'off',
    practice: false,
    liveOpInFlight: false,
    seedSet: true,
    unconfirmed: s.actionsUnconfirmed?.kind ?? null,
    pending: null,
  };
}

/** The window's posture for a pushed status (the title needs no renderer signal). */
export const statusPosture = (s: EpoStatus, now: number): Posture => derivePosture(postureOfStatus(s), now);
