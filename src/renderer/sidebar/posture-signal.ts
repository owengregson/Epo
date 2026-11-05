/**
 * The renderer's one posture (spec §12.3, C.6): the shared `derivePosture` over the shell's signals, in one
 * cached computed. A push that changes no part of the posture keeps the previous object, so nothing that
 * reads it re-renders and a deadline animation is never re-armed for the same deadline.
 */
import { computed, type ReadonlySignal } from '@preact/signals';
import { activitySignal, pendingControlSignal } from '@/renderer/app/live-signals';
import { pruneSignal, settingsFactsSignal, settingsViewSignal, statusSignal } from '@/renderer/app/shell-context';
import { derivePosture, type Posture, type PostureInput } from '@/shared/posture';

/** A starting account is chosen: the store's facts once built, else the settings view. */
function seedChosen(): boolean {
  const facts = settingsFactsSignal.value;
  if (facts?.built) return facts.seed.kind !== 'none';
  const view = settingsViewSignal.value;
  // Before the first projection, avoid flashing setup instructions at an existing install.
  return view === null || view.seed.trim() !== '';
}

export const postureInputSignal: ReadonlySignal<PostureInput> = computed(() => {
  const s = statusSignal.value;
  const prune = pruneSignal.value;
  const plan = s?.plan ?? null;
  return {
    boot: s?.boot ? { phase: s.boot.phase, identity: s.boot.identity, data: s.boot.data, startup: s.boot.startup } : null,
    status: s === null ? null : {
      basis: s.basis, loggedIn: s.loggedIn, state: s.state, online: s.online, haltReason: s.haltReason,
      parkReason: s.parkReason ?? null, parkedUntil: s.parkedUntil ?? null, nextActionAt: s.nextActionAt,
      lastActionAt: s.lastActionAt, hasStepped: s.lastStep !== null,
      recovery: s.recovery === null ? null : { phase: s.recovery.phase, resumeAt: s.recovery.resumeAt },
      runtime: s.runtime === undefined ? null
        : { desired: s.runtime.desired, phase: s.runtime.phase, blockedReason: s.runtime.blockedReason },
    },
    prune: prune === null ? null : { state: prune.state, nextActionAt: prune.nextActionAt },
    plan: plan === null ? null : {
      totalsPlanned: plan.totals.planned, remaining: plan.totals.remaining, sessionIdx: plan.now.sessionIdx,
      nextAt: plan.now.nextAt, dayOff: plan.day.dayOff, lateStart: plan.day.lateStart, light: plan.day.light,
    },
    catchUpRunning: s?.catchUp?.state === 'running',
    boost: s?.boost?.state ?? 'off',
    practice: settingsViewSignal.value?.prefs.practice ?? false,
    liveOpInFlight: activitySignal.value?.activity != null,
    seedSet: seedChosen(),
    unconfirmed: s?.actionsUnconfirmed?.kind ?? null,
    pending: pendingControlSignal.value,
  };
});

/** Two postures that render the same: same kind, controls, deadline, ring, attention and overlays. */
function same(a: Posture, b: Posture): boolean {
  return a.kind === b.kind && a.tone === b.tone && a.driver === b.driver && a.primary === b.primary
    && a.secondary === b.secondary && a.busy === b.busy && a.explain === b.explain
    && a.countdown?.to === b.countdown?.to && a.countdown?.toward === b.countdown?.toward
    && a.attention?.key === b.attention?.key && a.attention?.raw === b.attention?.raw
    && a.overlay.boost === b.overlay.boost && a.overlay.practice === b.overlay.practice
    && a.overlay.careful === b.overlay.careful;
}

let last: Posture | null = null;

export const postureSignal: ReadonlySignal<Posture> = computed(() => {
  const next = derivePosture(postureInputSignal.value, Date.now());
  if (last !== null && same(last, next)) return last;
  last = next;
  return next;
});
