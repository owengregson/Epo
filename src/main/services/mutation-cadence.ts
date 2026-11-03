/**
 * The mutation cadence (ADR 0607, spec §5.13 S2): the plan's admission, asked BEFORE any visit; the
 * deadline drawn from the session's gap spec at the dispatch closure and persisted there, once per
 * action; one deadline per accept pass; and the manual headroom. The one writer of the shared deadline.
 */

import { ActionDeferredError } from '@/adapter/errors';
import type { Admission, PlanView } from '@/governors/plan-types';
import { drawGapMs, type MutationKind, u, type Writer } from '@/kernel/plan';
import type { TempoKey } from '@/kernel/tempo';
import { MS_PER_HOUR } from '@/kernel/units';
import * as logger from '@/utils/logger';

/** The account a write is for, and its journal intent when one exists. */
export interface MutationSubject {
  readonly pk: string;
  readonly intentId?: string;
}

export interface MutationCadence {
  /** The plan's admission at `now`, with this account's journal (no I/O; BEFORE the visit). */
  preflight(kind: MutationKind, writer: Writer, now: number, subject?: MutationSubject): Admission;
  /** The dispatch closure: re-check the admission, draw the gap, persist the deadline; a refusal throws. */
  armAtDispatch(kind: MutationKind, writer: Writer, now: number, subject?: MutationSubject): number;
  /** One accept landed: the pass's one gap (drawn once) is owed after it, persisted. */
  acceptPassEnded(now: number): number;
  /** Whether the accept pass under way, or a new one, admits one more accept. */
  acceptAllowed(now: number): boolean;
  /** A single manual action: the ceiling and the hourly cap only (spec §5.7). */
  manualOpen(now: number): Admission;
}

export interface MutationCadenceDeps {
  plan: { view(now: number): PlanView };
  store: {
    getActionDelayDeadline(): number | null;
    setActionDelayDeadline(at: number | null): void;
    recentMutationTimes(since: number): readonly number[];
  };
}

/** The tempo spec the dispatch draw realizes: the session's gap shape, solved by the plan. */
const GAP_KEY: TempoKey = 'gap.action';

/** The pass under way: how many accepts it admits, how many landed, its one gap and the deadline it armed. */
interface AcceptPass {
  allowed: number;
  done: number;
  gapMs: number | null;
  armed: number | null;
}

export function createMutationCadence(d: MutationCadenceDeps): MutationCadence {
  let pass: AcceptPass | null = null;

  const recent = (now: number): readonly number[] => d.store.recentMutationTimes(now - MS_PER_HOUR);

  /**
   * One gap at dispatch (spec §5.10): the session's spec over the trailing hour with this action at
   * `now`, from the counter draw `u(seed, 'gap', s, k, attempt)` (k = the session's writes, restart-stable).
   */
  const gapAt = (view: PlanView, now: number): number => {
    const s = view.open?.idx ?? null;
    const k = s === null ? view.used.all : view.sessions[s].used;
    const coord = s ?? 'ambient';
    return drawGapMs(view.tempo.gap, [...recent(now), now], now, (attempt) => u(view.plan.seed, 'gap', coord, k, attempt));
  };

  /** Never shortens a deadline already owed. */
  const persist = (at: number): number => {
    const next = Math.max(d.store.getActionDelayDeadline() ?? 0, at);
    d.store.setActionDelayDeadline(next);
    logger.debug('cadence: deadline armed', { key: GAP_KEY, at: next });
    return next;
  };

  /** A pass stays open while the deadline it armed is the one still owed (any other write closes it). */
  const passOpen = (now: number): boolean => {
    const owed = d.store.getActionDelayDeadline();
    return pass !== null && pass.armed !== null && pass.armed === owed && owed > now;
  };

  return {
    preflight: (kind, writer, now, subject) => d.plan.view(now).admits(kind, writer, subject),
    armAtDispatch: (kind, writer, now, subject) => {
      const view = d.plan.view(now);
      const admission = view.admits(kind, writer, subject);
      if (!admission.ok) {
        throw new ActionDeferredError(`deferred at dispatch: ${admission.reason}`,
          { reason: admission.reason, until: admission.until });
      }
      return persist(now + gapAt(view, now));
    },
    acceptAllowed: (now) => {
      if (passOpen(now) && pass !== null) return pass.done < pass.allowed;
      const view = d.plan.view(now);
      if (!view.admits('accept', 'accept-pass').ok) {
        pass = null;
        return false;
      }
      const lastHour = recent(now).filter((t) => t > now - MS_PER_HOUR && t <= now).length;
      pass = { allowed: view.acceptsAllowed(Number.POSITIVE_INFINITY, lastHour), done: 0, gapMs: null, armed: null };
      return pass.allowed > 0;
    },
    acceptPassEnded: (now) => {
      const view = d.plan.view(now);
      const p: AcceptPass = pass ?? { allowed: 0, done: 0, gapMs: null, armed: null };
      pass = p;
      p.done += 1;
      p.gapMs ??= gapAt(view, now);
      p.armed = persist(now + p.gapMs);
      return p.armed;
    },
    manualOpen: (now) => d.plan.view(now).manualOpen(),
  };
}
