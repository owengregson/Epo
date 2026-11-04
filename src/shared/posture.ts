/**
 * Posture: one vocabulary, one pure function (spec §12.3). The renderer derives the live column's posture
 * from its signals and main the window title and Dock badge from the same function. `POSTURE_RULES` is the
 * precedence table: the first rule that holds names the kind.
 */
import { type Attention, type AttentionAction, classifyBlock } from './attention';
import type { BootView } from './boot';

export type { Attention, AttentionAction } from './attention';

export type PostureKind =
  | 'starting-up' | 'data-unavailable' | 'signed-out' | 'needs-attention' | 'sleeping' | 'reconnecting'
  | 'offline' | 'cleaning-up' | 'catching-up' | 'starting' | 'paused' | 'needs-seed' | 'stopped'
  | 'taking-a-break' | 'day-off' | 'done-for-today' | 'pacing' | 'retrying' | 'resting' | 'working';
export type PostureTone = 'live' | 'calm' | 'idle' | 'hold' | 'alert';

export type PrimaryControl =
  | 'start' | 'starting' | 'pause' | 'resume' | 'sign-in' | 'set-up' | 'pause-cleanup' | 'resume-cleanup'
  | 'diagnostics' | Exclude<AttentionAction, 'start' | 'diagnostics' | 'restart-app' | 'wait'> | null;

export interface Countdown {
  /** The anchor of the fraction (the last action, a park start, …). */
  readonly from: number;
  /** The deadline (epoch ms), always after `from`. */
  readonly to: number;
  readonly toward: 'next-step' | 'next-session' | 'retry' | 'resume' | 'cleanup-step';
}

export type ExplainTopic = 'resting' | 'pacing-hour' | 'pacing-visits' | 'retrying' | 'taking-a-break'
  | 'done-for-today' | 'day-off' | 'catching-up' | 'boost' | 'practice';

export interface Posture {
  readonly kind: PostureKind;
  readonly tone: PostureTone;
  readonly driver: 'growth' | 'prune';
  readonly primary: PrimaryControl;
  readonly secondary: 'stop' | 'stop-cleanup' | 'start' | null;
  readonly countdown: Countdown | null;
  /** The indeterminate ring. */
  readonly busy: boolean;
  readonly attention: Attention | null;
  readonly overlay: { readonly boost: boolean; readonly practice: boolean; readonly careful: boolean };
  /** The "Why?" popover topic. */
  readonly explain: ExplainTopic | null;
}

/** Plain inputs (renderer-safe): the renderer builds them from its signals, main from its projections. */
export interface PostureInput {
  readonly boot: Pick<BootView, 'phase' | 'identity' | 'data' | 'startup'> | null;
  readonly status: {
    readonly basis: 'built' | 'not-built';
    readonly loggedIn: boolean;
    readonly state: 'idle' | 'running' | 'paused' | 'halted';
    readonly online: boolean;
    readonly haltReason: string | null;
    readonly parkReason: string | null;
    readonly parkedUntil: number | null;
    readonly nextActionAt: number | null;
    readonly lastActionAt: number | null;
    /** `lastStep !== null`. */
    readonly hasStepped: boolean;
    readonly recovery: { readonly phase: 'holding' | 'probing'; readonly resumeAt: number | null } | null;
    readonly runtime: {
      readonly desired: 'stopped' | 'paused' | 'running';
      readonly phase: 'ready' | 'suspended' | 'reconciling' | 'recovering';
      readonly blockedReason: string | null;
    } | null;
  } | null;
  readonly prune: { readonly state: string; readonly nextActionAt: number | null } | null;
  /** The plan's day (`PlanProjection.day` and totals). */
  readonly plan: {
    readonly totalsPlanned: number; readonly remaining: number; readonly sessionIdx: number | null;
    readonly nextAt: number | null; readonly dayOff: boolean; readonly lateStart: boolean; readonly light: boolean;
  } | null;
  /** `catchUp.state === 'running'`. */
  readonly catchUpRunning: boolean;
  /** `BoostView.state`; the pill is an indicator only. */
  readonly boost: 'off' | 'on' | 'waiting' | 'paused';
  /** Practice mode (engine name dryRun). */
  readonly practice: boolean;
  /** A live op is in flight (the activity push). */
  readonly liveOpInFlight: boolean;
  /** `settingsFacts.seed.kind !== 'none'`. */
  readonly seedSet: boolean;
  /** `status.actionsUnconfirmed`. */
  readonly unconfirmed: 'follow' | 'unfollow' | null;
  /** The renderer's in-flight control. */
  readonly pending: 'start' | 'pause' | 'stop' | null;
}

type S = NonNullable<PostureInput['status']>;
const running = (s: S): boolean => s.state === 'running';
const pruneActive = (i: PostureInput): boolean =>
  i.prune !== null && (i.prune.state === 'scanning' || i.prune.state === 'running' || i.prune.state === 'paused');

/** A first step publishes its action or long wait before it completes; those facts already name its posture. */
function starting(i: PostureInput, s: S): boolean {
  if (i.boot?.startup.startQueued) return true;
  if (!running(s)) return i.pending === 'start';
  return !s.hasStepped && s.parkReason === null && s.nextActionAt === null && s.recovery === null
    && !i.liveOpInFlight
    && (i.plan === null || (!i.plan.dayOff && i.plan.remaining > 0 && i.plan.sessionIdx !== null));
}

/** One precedence row: the kind and the condition that selects it. */
export interface PostureRule {
  readonly kind: PostureKind;
  when(i: PostureInput, s: S): boolean;
}

/** The precedence table (spec §12.3), first match wins; `starting-up` also covers a status not yet known. */
export const POSTURE_RULES: readonly PostureRule[] = [
  { kind: 'starting-up', when: (i) => i.boot?.phase === 'starting' },
  { kind: 'data-unavailable', when: (i) => i.boot?.data === 'unavailable' },
  { kind: 'signed-out', when: (i, s) => i.boot?.identity === 'signed-out' || !s.loggedIn },
  { kind: 'needs-attention', when: (_, s) => s.runtime?.blockedReason != null || s.state === 'halted' },
  { kind: 'sleeping', when: (_, s) => s.runtime?.phase === 'suspended' },
  { kind: 'reconnecting', when: (_, s) => s.runtime?.phase === 'reconciling' || s.runtime?.phase === 'recovering' },
  { kind: 'offline', when: (_, s) => !s.online && (s.runtime?.desired === 'running' || running(s)) },
  { kind: 'cleaning-up', when: (i) => pruneActive(i) },
  { kind: 'catching-up', when: (i) => (i.boot?.startup.step ?? null) !== null || i.catchUpRunning },
  { kind: 'starting', when: starting },
  { kind: 'paused', when: (_, s) => s.state === 'paused' || (s.runtime?.desired === 'paused' && s.state === 'idle') },
  { kind: 'needs-seed', when: (i, s) => s.state === 'idle' && !i.seedSet },
  { kind: 'stopped', when: (_, s) => s.state === 'idle' },
  { kind: 'working', when: (i, s) => running(s) && i.liveOpInFlight },
  { kind: 'taking-a-break', when: (_, s) => s.recovery?.phase === 'holding' },
  { kind: 'day-off', when: (i, s) => running(s) && i.plan?.dayOff === true },
  { kind: 'done-for-today', when: (i, s) => s.parkReason === 'daily-ceiling' || i.plan?.remaining === 0 },
  { kind: 'pacing', when: (_, s) => s.parkReason === 'velocity' || s.parkReason === 'read-budget' },
  { kind: 'retrying', when: (_, s) => s.parkReason === 'enrich-backoff' },
  { kind: 'resting', when: (i, s) => s.parkReason === 'session' || (i.plan !== null && i.plan.sessionIdx === null) },
  { kind: 'working', when: () => true },
];

const TONE: Readonly<Record<PostureKind, PostureTone>> = {
  'starting-up': 'idle', 'data-unavailable': 'alert', 'signed-out': 'idle', 'needs-attention': 'alert',
  sleeping: 'calm', reconnecting: 'hold', offline: 'hold', 'cleaning-up': 'live', 'catching-up': 'live',
  starting: 'live', paused: 'hold', 'needs-seed': 'idle', stopped: 'idle', 'taking-a-break': 'hold',
  'day-off': 'calm', 'done-for-today': 'calm', pacing: 'calm', retrying: 'hold', resting: 'calm', working: 'live',
};

/** Window-title headlines, each at most 15 characters. */
const HEADLINE: Readonly<Record<PostureKind, string>> = {
  'starting-up': 'Starting up', 'data-unavailable': "Can't open data", 'signed-out': 'Signed out',
  'needs-attention': 'Needs attention', sleeping: 'Sleeping', reconnecting: 'Reconnecting', offline: 'Offline',
  'cleaning-up': 'Pruning', 'catching-up': 'Catching up', starting: 'Starting', paused: 'Paused',
  'needs-seed': 'Get set up', stopped: 'Stopped', 'taking-a-break': 'Taking a break', 'day-off': 'Day off',
  'done-for-today': 'Done for today', pacing: 'Pacing', retrying: 'Retrying soon', resting: 'Resting',
  working: 'Working',
};

export function postureHeadline(kind: PostureKind): string {
  return HEADLINE[kind];
}

const ATTENTION_PRIMARY: Readonly<Record<AttentionAction, PrimaryControl>> = {
  start: 'start', 'show-live': 'show-live', 'choose-seed': 'choose-seed', 'check-update': 'check-update',
  'open-prune': 'open-prune', diagnostics: 'diagnostics', 'restart-app': null, wait: null,
};

const countdown = (from: number | null, to: number | null, toward: Countdown['toward'], now: number): Countdown | null => {
  if (to === null) return null;
  const anchor = from !== null && from < to ? from : Math.min(now, to);
  return anchor < to ? { from: anchor, to, toward } : null;
};

/** The one posture for these inputs: the first `POSTURE_RULES` row that holds. */
export function derivePosture(
  input: PostureInput,
  now: number,
  classify: (raw: string) => Attention = classifyBlock,
): Posture {
  const s = input.status;
  // A status not yet known reads as starting up: no later row can be judged without one.
  const kind = s === null ? 'starting-up' : (POSTURE_RULES.find((r) => r.when(input, s))?.kind ?? 'working');
  // Stop also cancels a Start that is still on its way (queued behind the startup sequence, or pressed).
  const stoppable = (s !== null && (s.state === 'running' || s.state === 'paused'))
    || input.boot?.startup.startQueued === true || input.pending === 'start';
  let primary: PrimaryControl = null;
  let secondary: Posture['secondary'] = stoppable ? 'stop' : null;
  let attention: Attention | null = null;
  let timer: Countdown | null = null;
  let explain: ExplainTopic | null = null;
  const parked = s?.parkedUntil ?? null;
  const last = s?.lastActionAt ?? null;
  switch (kind) {
    case 'starting-up': secondary = null; break;
    case 'data-unavailable': primary = 'diagnostics'; secondary = null; break;
    case 'signed-out': primary = 'sign-in'; secondary = null; break;
    case 'needs-attention': {
      attention = classify(s?.runtime?.blockedReason ?? s?.haltReason ?? 'unknown');
      primary = ATTENTION_PRIMARY[attention.action];
      secondary = primary === 'start' || attention.action === 'wait' ? null : 'start';
      break;
    }
    case 'sleeping': primary = s?.runtime?.desired === 'running' ? 'pause' : null; break;
    case 'reconnecting': case 'offline': primary = 'pause'; break;
    case 'cleaning-up': {
      const paused = input.prune?.state === 'paused';
      primary = paused ? 'resume-cleanup' : 'pause-cleanup';
      secondary = 'stop-cleanup';
      timer = paused ? null : countdown(last, input.prune?.nextActionAt ?? null, 'cleanup-step', now);
      break;
    }
    case 'catching-up':
      primary = input.boot?.startup.startQueued ? 'starting' : s?.state === 'running' ? 'pause' : 'start';
      explain = 'catching-up';
      break;
    case 'starting': primary = 'starting'; break;
    case 'paused': primary = 'resume'; break;
    case 'needs-seed': primary = 'set-up'; break;
    case 'stopped': primary = 'start'; break;
    case 'taking-a-break':
      primary = 'pause'; explain = 'taking-a-break';
      timer = countdown(last, s?.recovery?.resumeAt ?? null, 'resume', now);
      break;
    case 'day-off': case 'done-for-today': case 'resting':
      primary = 'pause'; explain = kind;
      timer = countdown(last, parked ?? input.plan?.nextAt ?? null, 'next-session', now);
      break;
    case 'pacing':
      primary = 'pause'; explain = s?.parkReason === 'read-budget' ? 'pacing-visits' : 'pacing-hour';
      timer = countdown(last, parked, 'resume', now);
      break;
    case 'retrying': primary = 'pause'; explain = 'retrying'; timer = countdown(last, parked, 'retry', now); break;
    case 'working':
      // While an op is in flight the ring shows the step itself, not a stale deadline.
      primary = 'pause';
      timer = input.liveOpInFlight ? null : countdown(last, s?.nextActionAt ?? null, 'next-step', now);
      break;
  }
  if (attention === null && input.unconfirmed !== null) attention = classify('actions-unconfirmed');
  // An overlay explains itself where the posture has no topic of its own.
  explain ??= input.boost !== 'off' ? 'boost' : input.practice ? 'practice' : null;
  const busy = kind === 'starting-up' || kind === 'reconnecting' || kind === 'catching-up' || kind === 'starting'
    || (kind === 'working' && timer === null);
  return {
    kind, tone: TONE[kind], driver: kind === 'cleaning-up' ? 'prune' : 'growth', primary, secondary,
    countdown: timer, busy, attention,
    overlay: { boost: input.boost !== 'off', practice: input.practice, careful: s?.recovery?.phase === 'probing' },
    explain,
  };
}
