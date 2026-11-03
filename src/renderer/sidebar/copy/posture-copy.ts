/**
 * Posture copy (spec Appendix C.15.1, "Prune" wording): the headline, the now line when no step is in
 * flight, the next line, and the words on the Now zone's controls. Headlines are `postureHeadline` (≤ 15
 * characters, shared with the window title); every count and time comes from the status or the plan.
 */
import type { Res } from '@/ipc/contract';
import { atTime, clock, count, countdownText, weekdayTime } from '@/renderer/sidebar/format';
import type { Posture, PostureKind, PrimaryControl } from '@/shared/posture';
import { postureHeadline } from '@/shared/posture';

type Status = Res<'status'>;
type Prune = Res<'pruneStatus'>;

export interface NowFacts {
  readonly status: Status | null;
  readonly prune: Prune | null;
  readonly now: number;
}

/** The headline; a paused prune says so (the window title keeps the kind's own word). */
export function headlineOf(p: Posture, prune: Prune | null): string {
  return p.kind === 'cleaning-up' && prune?.state === 'paused' ? 'Pruning paused' : postureHeadline(p.kind);
}

const DATA_PROBLEM = {
  'future-version': 'This data was saved by a newer Epo. Update Epo to open it.',
  unreadable: 'Epo couldn’t read its data file. Diagnostics has details.',
  locked: 'Another copy of Epo may be open. Close it, then reopen Epo.',
} as const;

const STARTUP_STEP = {
  'open-own-profile': 'Opening your profile',
  'confirm-account': 'Confirming your account',
  'catch-up': 'Checking what changed while Epo was closed',
  'resume-run': 'Picking up where Epo left off',
} as const;

const CATCH_UP_STEP = {
  profile: 'Opening your profile',
  notifications: 'Checking your notifications',
  'followers-head': 'Looking at your newest followers',
} as const;

function catchingUpLine(s: Status | null): string {
  const step = s?.boot?.startup.step ?? null;
  const running = s?.catchUp?.steps.find((x) => x.step.state === 'running');
  if (running !== undefined && (step === null || step === 'catch-up')) return CATCH_UP_STEP[running.id];
  return step === null ? STARTUP_STEP['catch-up'] : STARTUP_STEP[step];
}

function pruneLine(prune: Prune | null): string {
  if (prune?.state === 'paused') return 'Paused by you. Press Resume to continue.';
  if (prune?.state === 'scanning') {
    const side = prune.scanPhase;
    const total = side === null ? null : (prune.scanEstimates?.[side] ?? null);
    const done = side === null ? null : prune[side];
    const of = done === null ? '' : total === null ? ` · ${count(done)}` : ` · ${count(done)} of ${count(total)}`;
    return `Checking who follows you back${of}`;
  }
  const all = (prune?.unfollowed ?? 0) + (prune?.remaining ?? 0);
  const of = all > 0 ? ` · ${count(prune?.unfollowed ?? 0)} of ${count(all)}` : '';
  return `Unfollowing people who don’t follow back${of}`;
}

/** The now line when no step is in flight (with one, the live-op sentence takes its place). */
export function sentenceOf(p: Posture, f: NowFacts): string {
  const s = f.status;
  switch (p.kind) {
    case 'starting-up': return 'Getting Epo ready.';
    case 'data-unavailable': return DATA_PROBLEM[s?.boot?.dataProblem ?? 'unreadable'];
    case 'signed-out': return 'Sign in to Instagram on the Live tab. Your login stays on this computer.';
    case 'needs-attention': return '';
    case 'sleeping': return 'Your computer is asleep. Epo continues when it wakes.';
    case 'reconnecting':
      return s?.runtime?.phase === 'recovering' ? 'Getting the Instagram page ready again.' : 'Checking the Instagram page after sleep.';
    case 'offline': return 'Waiting for your internet connection. Epo picks up where it left off.';
    case 'cleaning-up': return pruneLine(f.prune);
    case 'catching-up': return catchingUpLine(s);
    case 'starting': return 'Getting the first step ready.';
    case 'paused':
      return s?.state === 'idle' ? 'You paused Epo before it closed. Press Resume to continue.' : 'Paused by you. Press Resume to continue.';
    case 'needs-seed': return 'Choose a starting account whose followers look like your audience.';
    case 'stopped':
      return s?.lastActionAt != null ? `Last active ${weekdayTime(s.lastActionAt)}.` : 'Press Start when you’re ready.';
    case 'taking-a-break': return 'Instagram is limiting activity right now.';
    case 'day-off': return 'Epo takes today off. Back tomorrow.';
    case 'done-for-today': {
      const day = s?.plan?.day;
      if (s?.parkReason === 'daily-ceiling') return 'Today’s limit is reached.';
      if (day?.lateStart === true && s?.plan?.totals.planned === 0) return 'Today’s sessions had already passed when Epo opened.';
      if (day?.light === true && s?.plan?.totals.planned === 0) return 'Light day — no actions planned today.';
      return 'Today’s plan is done.';
    }
    case 'pacing': return s?.parkReason === 'read-budget' ? 'Saving profile visits for later.' : 'Keeping an even pace this hour.';
    case 'retrying': return 'Couldn’t look at profiles just now.';
    case 'resting': return 'Between sessions.';
    case 'working': {
      if (p.overlay.careful) return 'Checking that Instagram’s limit has lifted';
      if (p.overlay.boost) return 'Finding and following new people';
      const source = s?.currentTargetUsername ?? null;
      return source === null ? 'Finding new people' : `Finding people through @${source}’s followers`;
    }
  }
}

/** The next line: when the next thing happens, from the posture's own deadline or the plan. */
export function nextLineOf(p: Posture, f: NowFacts): string | null {
  const s = f.status;
  const to = p.countdown?.to ?? null;
  switch (p.kind) {
    case 'working': case 'cleaning-up': {
      if (to === null) return null;
      const what = p.kind === 'working' ? 'Next step' : 'Next unfollow';
      const left = countdownText(to, f.now);
      return left === null ? `${what} ${atTime(to, f.now)}` : `${what} in ${left}`;
    }
    case 'resting': case 'day-off': case 'done-for-today':
      return to === null ? null : `Next session ${atTime(to, f.now)}`;
    case 'pacing': return to === null ? null : `Continuing ${atTime(to, f.now)}`;
    case 'retrying': return to === null ? null : `Trying again ${atTime(to, f.now)}`;
    case 'taking-a-break': {
      const r = s?.recovery;
      if (to === null || r == null) return null;
      return `Trying again at ${clock(to)} · attempt ${r.attempt} of ${r.maxAttempts}`;
    }
    case 'catching-up':
      if (s?.boot?.startup.startQueued === true) return 'Epo starts right after this check.';
      return s?.state === 'running' ? null : 'You can press Start anytime.';
    case 'stopped': {
      const plan = s?.plan;
      if (plan == null || plan.totals.planned === 0) return null;
      return `Today’s plan: about ${count(plan.totals.planned)} actions in ${count(plan.sessions.length)} sessions`;
    }
    default: return null;
  }
}

export interface ControlFace {
  readonly label: string;
  readonly icon: string;
  readonly brand?: boolean;
}

export const PRIMARY_FACE: Readonly<Record<NonNullable<PrimaryControl>, ControlFace>> = {
  start: { label: 'Start', icon: 'play' },
  starting: { label: 'Starting…', icon: 'hourglass-half' },
  pause: { label: 'Pause', icon: 'pause' },
  resume: { label: 'Resume', icon: 'play' },
  'sign-in': { label: 'Sign in', icon: 'instagram', brand: true },
  'set-up': { label: 'Set up', icon: 'sliders' },
  'pause-cleanup': { label: 'Pause pruning', icon: 'pause' },
  'resume-cleanup': { label: 'Resume pruning', icon: 'play' },
  'show-live': { label: 'Open Live', icon: 'instagram', brand: true },
  'choose-seed': { label: 'Choose account', icon: 'bullseye' },
  'check-update': { label: 'Check for updates', icon: 'arrows-rotate' },
  'open-prune': { label: 'Open Prune', icon: 'user-minus' },
  diagnostics: { label: 'Diagnostics', icon: 'magnifying-glass-chart' },
};

export const SECONDARY_LABEL = { stop: 'Stop', 'stop-cleanup': 'Stop pruning', start: 'Start' } as const;

/** The ring's glyph: one per kind, so a posture reads at a glance. */
export const RING_GLYPH: Readonly<Record<PostureKind, ControlFace['icon']>> = {
  'starting-up': 'hourglass-half', 'data-unavailable': 'database', 'signed-out': 'user-lock',
  'needs-attention': 'circle-exclamation', sleeping: 'moon', reconnecting: 'arrows-rotate', offline: 'wifi',
  'cleaning-up': 'user-minus', 'catching-up': 'arrows-rotate', starting: 'play', paused: 'pause',
  'needs-seed': 'bullseye', stopped: 'play', 'taking-a-break': 'hourglass-half', 'day-off': 'calendar-check',
  'done-for-today': 'check', pacing: 'gauge-high', retrying: 'arrows-rotate', resting: 'hourglass-half',
  working: 'wave-square',
};

/** The two overlay pills (indicators only, never buttons). */
export const PILL = { boost: 'Boost', practice: 'Practice' } as const;
