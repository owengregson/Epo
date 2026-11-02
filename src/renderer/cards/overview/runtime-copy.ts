import { durationCoarse, withAt } from '@/renderer/lib/format';
import type { ChainTargetView, EpoStatus } from '@/types';

export interface RuntimeHold { headline: string; caption: string; alert?: boolean }

/** Runtime admission wins over an engine countdown: a saved run can be waiting
 * for the device even while the old engine loop has already stopped. */
export function runtimeHold(status: EpoStatus | null, otherDriver = false): RuntimeHold | null {
  const runtime = status?.runtime;
  if (runtime?.blockedReason) {
    const reasons: Record<string, string> = {
      'account-changed': 'The signed-in account changed. Check the account, then press Start.',
      'account-identity-unavailable': 'Sign in to the expected account, then press Start.',
      'runtime-recovery-exhausted': 'Three device repairs were needed within an hour. Check the Instagram tab before restarting.',
      'runtime-state-persist-failed': 'Run state could not be saved. Check available disk space and restart Epo.',
      'wake-recovery-failed': 'The Instagram tab could not recover after sleep. Check the tab before restarting.',
      'wake-reconciliation-failed': 'The device check failed after sleep. Check the Instagram tab before restarting.',
      'wake-sentinel-failed': 'The session could not be checked after sleep. Check the Instagram tab before restarting.',
      'automatic-resume-failed': 'The saved run could not resume. Check the Instagram tab before restarting.',
    };
    return { headline: 'Needs attention', caption: reasons[runtime.blockedReason]
      ?? `Run blocked: ${runtime.blockedReason}. Check the session before restarting.`, alert: true };
  }
  if (runtime?.phase === 'suspended') return { headline: 'Sleeping', caption: 'Work is suspended until the device wakes.' };
  if (runtime?.phase === 'reconciling') return { headline: 'Checking session', caption: 'Checking the device and account after sleep.' };
  if (runtime?.phase === 'recovering') return { headline: 'Recovering', caption: 'Repairing the Instagram tab before work resumes.' };
  if (status?.state === 'running' && status.online && status.reentry?.phase === 'reconcile') {
    const gap = status.reentry.absentMs;
    return { headline: 'Refreshing', caption: gap > 0
      ? `Checking relationships after ${durationCoarse(gap)} away.`
      : 'Checking current relationships and unfinished actions before continuing.' };
  }
  if (!otherDriver && runtime?.desired === 'paused' && status?.state !== 'running') return { headline: 'Paused', caption: 'Waiting for you to resume.' };
  if (!otherDriver && runtime?.desired === 'stopped' && status?.state === 'idle') return { headline: 'Stopped', caption: 'Press Start when you are ready.' };
  return null;
}

export function progressCaption(status: EpoStatus | null, now: number): string | null {
  const candidates = [status?.health, status?.runtime].filter((s) => s?.lastProgressAt != null && s.progressPhase !== null);
  const latest = candidates.sort((a, b) => (b?.lastProgressAt ?? 0) - (a?.lastProgressAt ?? 0))[0];
  if (latest?.lastProgressAt == null) return null;
  const minutes = Math.floor(Math.max(0, now - latest.lastProgressAt) / 60_000);
  const ago = minutes < 1 ? 'just now' : `${durationCoarse(now - latest.lastProgressAt)} ago`;
  return `Last progress ${ago}${latest.progressPhase ? ` · ${latest.progressPhase.replaceAll('-', ' ')}` : ''}`;
}

/** Revisit times mean eligible for scheduling, not a promised exact action time. */
export function frontierCaption(status: EpoStatus | null, chain: readonly ChainTargetView[], now: number): string[] {
  const frontier = status?.frontier;
  if (!frontier || frontier.sources.length === 0) return [];
  const captions: string[] = [];
  const active = frontier.sources.find((source) => source.pk === frontier.currentTargetPk);
  if (active?.visit) captions.push(`This visit: ${active.visit.follows} follows · ${frontier.sources.length} sources in rotation`);
  const previous = frontier.sources.filter((source) => source.lastReason !== null && source.pk !== frontier.currentTargetPk)
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)[0];
  if (previous?.lastReason) {
    const labels = {
      'visit-budget': 'visit limit reached', 'low-yield': 'few eligible people found',
      'verified-ended': 'visible list fully explored', 'coverage-policy': 'coverage limit reached',
    };
    const name = chain.find((target) => target.accountPk === previous.pk)?.username;
    captions.push(`Last rotation${name ? ` from ${withAt(name)}` : ''}: ${labels[previous.lastReason]}.`);
  }
  const next = frontier.sources.filter((source) => source.resumeAt > now)
    .sort((a, b) => a.resumeAt - b.resumeAt)[0];
  if (next) captions.push(`Next revisit eligible ${new Date(next.resumeAt).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })}.`);
  return captions;
}
