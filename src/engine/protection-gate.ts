/**
 * The protection gate (spec §7.4–7.5): the subject from stored facts (selection) or from a fresh
 * observation's own fields (the click), and the moves into and out of `kept`.
 */

import {
  type ProtectionIndex, type ProtectionSubject, type ProtectionVerdict, protectionVerdict,
} from '../shared/unfollow-protection';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { AccountState, FollowRecord, KeptReason, Observation } from '../store/types';
import type { ProtectionPort } from './protection-port';

export type { KeptReason } from '../store/types';

/** A verdict that keeps a record: a rule matched, or a configured rule's fact was unreadable. */
export type KeepingVerdict = Extract<ProtectionVerdict, { kind: 'protected' | 'unknown' }>;

/** What `kept` records about why, when, and when it is read again (null: never, a rule keeps it). */
export interface KeptStamp {
  readonly reason: KeptReason; readonly match: string | null; readonly at: number;
  readonly recheckAt: number | null; readonly checks: number;
}

/** The store slice the gate reads and writes. */
export type KeptStore = Pick<KnowledgeStore, 'getAccount' | 'followRecords'>;

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** The subject as the store holds it: selection makes no visit, and a stale matching bio still protects. */
export function storedSubject(store: { getAccount(pk: string): AccountState | null }, pk: string): ProtectionSubject {
  const a = store.getAccount(pk);
  return { pk, username: text(a?.username) ?? null, bio: text(a?.bio), isVerified: flag(a?.isVerified) };
}

/** The subject from THIS observation's own fields: the folded row would hide a bio the body no longer carries. */
export function freshSubject(obs: Observation, visitedUsername: string): ProtectionSubject {
  const f = obs.fields;
  return { pk: obs.accountPk, username: text(f.username) ?? visitedUsername, bio: text(f.bio), isVerified: flag(f.isVerified) };
}

/** The selection-time verdict over stored facts. */
export function selectionVerdict(
  store: { getAccount(pk: string): AccountState | null }, pk: string, idx: ProtectionIndex,
): ProtectionVerdict {
  return protectionVerdict(storedSubject(store, pk), idx);
}

/** A rule match keeps for good (until the rules change); an unreadable fact is read again on the plan's back-off. */
export function keptStampFor(v: KeepingVerdict, now: number, prevChecks: number, port: ProtectionPort): KeptStamp {
  if (v.kind === 'protected') return { reason: v.by, match: v.match, at: now, recheckAt: null, checks: 0 };
  const checks = prevChecks + 1;
  return { reason: `unreadable-${v.missing}`, match: null, at: now, recheckAt: now + port.recheckDelayMs(checks), checks };
}

/** Move a record into `kept` (non-blocking: it leaves every queue). */
export function keepRecord(store: KeptStore, rec: FollowRecord, s: KeptStamp): void {
  store.followRecords.review([{ pk: rec.accountPk, move: 'keep', stamp: s }]);
}

/** Where a released record goes: `followed_back` once a follow-back was observed, else `pending_followback`. */
export function releaseTarget(rec: FollowRecord): 'followed_back' | 'pending_followback' {
  return rec.followedBackAt !== undefined || rec.followbackObservedAt !== undefined ? 'followed_back' : 'pending_followback';
}

/** Return a kept record to the lifecycle; its fresh-evidence stamp is cleared. */
export function releaseRecord(store: KeptStore, rec: FollowRecord): void {
  store.followRecords.review([{ pk: rec.accountPk, move: 'release', to: releaseTarget(rec) }]);
}
