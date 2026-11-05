/**
 * The one protection predicate (spec §7.3): people by pk (or, unlinked, by username), Unicode-folded bio
 * words and verified accounts. It never reads follow-back state, and it is monotone: adding an entry, a word
 * or a rule never turns a protected or unknown subject clear. Pure, renderer-safe.
 */
import type { ProtectionSettings, ProtectionState } from './settings-model';

export interface ProtectionIndex {
  /** The settings revision it was compiled from. */
  readonly rev: number;
  readonly state: ProtectionState;
  /** Every entry that has a pk. */
  readonly pks: ReadonlySet<string>;
  /** Unlinked entries only (lowercase, no '@'). */
  readonly usernames: ReadonlySet<string>;
  /** Folded, trimmed, non-blank, deduped. */
  readonly words: readonly string[];
  readonly wordMatch: 'anywhere' | 'whole-word';
  readonly keepVerified: boolean;
}

export interface ProtectionSubject {
  readonly pk: string;
  readonly username: string | null;
  /** '' = observed and empty; undefined = not present in THIS evidence (never "no keyword"). */
  readonly bio: string | undefined;
  /** undefined = not present in THIS evidence. */
  readonly isVerified: boolean | undefined;
}

export type ProtectedBy = 'account' | 'verified' | 'bio-word' | 'source';

export type ProtectionVerdict =
  | { readonly kind: 'clear' }
  | { readonly kind: 'protected'; readonly by: ProtectedBy; readonly match: string }
  | { readonly kind: 'unknown'; readonly missing: 'bio' | 'verified' }
  | { readonly kind: 'paused'; readonly state: 'needs-review' | 'unavailable' };

/** A normalized Instagram handle: lowercase letters, digits, dot and underscore, 1–30 long. */
export const HANDLE_RE = /^[a-z0-9._]{1,30}$/;

/** Canonical decomposition, combining marks stripped, lowercased: capitals, accents and fancy fonts fold away. */
export function foldText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Trim, strip leading '@', lowercase; `valid` when the result is a handle. */
export function normalizeHandle(raw: string): { handle: string; valid: boolean } {
  const handle = raw.trim().replace(/^@/, '').toLowerCase();
  return { handle, valid: HANDLE_RE.test(handle) };
}

/** Compile the persisted settings into the lookup the predicate reads. */
export function compileProtection(p: ProtectionSettings, state: ProtectionState, rev: number): ProtectionIndex {
  const pks = new Set<string>();
  const usernames = new Set<string>();
  for (const a of p.accounts) {
    if (a.pk !== null) pks.add(a.pk);
    // A linked entry follows its pk through renames; an unlinked one also matches its handle.
    if (a.linkedAt === null && a.username.length > 0) usernames.add(a.username.toLowerCase());
  }
  const words = [...new Set(p.words.map((w) => foldText(w.text).trim()).filter((w) => w.length > 0))];
  return { rev, state, pks, usernames, words, wordMatch: p.wordMatch, keepVerified: p.keepVerified };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first configured word the bio contains, or null. */
export function matchedWord(bio: string, idx: Pick<ProtectionIndex, 'words' | 'wordMatch'>): string | null {
  const folded = foldText(bio);
  for (const word of idx.words) {
    const hit = idx.wordMatch === 'anywhere'
      ? folded.includes(word)
      : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'u').test(folded);
    if (hit) return word;
  }
  return null;
}

/** Precedence: paused → protected (account, verified, bio-word) → unknown → clear. */
export function protectionVerdict(s: ProtectionSubject, idx: ProtectionIndex): ProtectionVerdict {
  if (idx.state !== 'ready') return { kind: 'paused', state: idx.state };
  if (idx.pks.has(s.pk)) return { kind: 'protected', by: 'account', match: s.pk };
  const handle = s.username === null ? null : s.username.toLowerCase();
  if (handle !== null && idx.usernames.has(handle)) return { kind: 'protected', by: 'account', match: handle };
  if (idx.keepVerified && s.isVerified === true) return { kind: 'protected', by: 'verified', match: 'verified' };
  if (idx.words.length > 0 && s.bio !== undefined) {
    const word = matchedWord(s.bio, idx);
    if (word !== null) return { kind: 'protected', by: 'bio-word', match: word };
  }
  // 'unknown' only when a configured rule lacks its fact in this evidence.
  if (idx.words.length > 0 && s.bio === undefined) return { kind: 'unknown', missing: 'bio' };
  if (idx.keepVerified && s.isVerified === undefined) return { kind: 'unknown', missing: 'verified' };
  return { kind: 'clear' };
}
