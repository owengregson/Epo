/**
 * Presence-gated relationships (spec §10.4): each relationship key is read by presence, so a
 * renamed key is unknown rather than `false`. The ONLY place an `ObservedRelation` is minted.
 */

import type { ObservedRelation } from '@/shared/observed-relation';
import { admits } from '@/surface/read/admission';
import type { RelationshipFact, Tier } from '@/surface/schema/projection';

/** The declared relationship key names of a surface version. */
export interface RelationshipKeys {
  readonly following: string;
  readonly outgoingRequest: string;
  readonly followedBy: string;
  readonly incomingRequest: string;
}

const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** One relationship record: a key that is absent, `null` or not a boolean reads as `null` (unknown). */
export function readRelationship(record: Record<string, unknown>, keys: RelationshipKeys, pk: string): RelationshipFact {
  return {
    pk,
    following: flag(record[keys.following]),
    outgoingRequest: flag(record[keys.outgoingRequest]),
    followedBy: flag(record[keys.followedBy]),
    incomingRequest: flag(record[keys.incomingRequest]),
  };
}

/** `true` when either key says so; `false` only when both are present and false; else unknown. */
export function weFollowOf(r: Pick<RelationshipFact, 'following' | 'outgoingRequest'>): boolean | null {
  if (r.following === true || r.outgoingRequest === true) return true;
  return r.following === false && r.outgoingRequest === false ? false : null;
}

/**
 * Mint the facts a read may feed the reconciler: `weFollow:false` is destructive (a canonical or
 * normalized, complete read), `weFollow:true` is guarded (any read that was not recovered).
 */
export function mintObserved(
  read: { readonly tier: Tier; readonly partial: boolean },
  facts: readonly RelationshipFact[],
): ObservedRelation[] {
  const out: ObservedRelation[] = [];
  for (const fact of facts) {
    const weFollow = weFollowOf(fact);
    if (weFollow === null || !admits(weFollow ? 'guarded' : 'destructive', read)) continue;
    out.push({ pk: fact.pk, weFollow } as ObservedRelation);
  }
  return out;
}
