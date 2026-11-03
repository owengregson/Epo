/**
 * The typed live activity (spec §12.9, Appendix C.1): what the tab-driving
 * layers report they are doing, as data rather than free text. The veil and
 * the sidebar render it; renderer-safe and pure.
 */

/** Whether the work talks to the private JSON API or drives the page. */
export type ActivityKind = 'api' | 'page';

export type LiveOp =
  | { readonly op: 'follow'; readonly username: string }
  | { readonly op: 'unfollow'; readonly username: string }
  | { readonly op: 'accept-request'; readonly username: string }
  | { readonly op: 'open-list'; readonly list: 'followers' | 'following'; readonly of: string }
  /** Page scroll of a list dialog (the followers page reader). */
  | { readonly op: 'browse-list'; readonly list: 'followers' | 'following'; readonly of: string | null;
      readonly done: number; readonly total: number | null }
  /** API walk of a list (the list-page walker); `of: null` is our own list. */
  | { readonly op: 'read-list'; readonly list: 'followers' | 'following'; readonly of: string | null;
      readonly done: number; readonly total: number | null }
  | { readonly op: 'visit-profiles'; readonly done: number; readonly total: number }
  | { readonly op: 'visit-profile'; readonly username: string; readonly purpose: 'check-back' | 'verify' | 'settle' | 'seed' }
  | { readonly op: 'check-notifications' }
  | { readonly op: 'open-own-profile' }
  | { readonly op: 'confirm-account' };

/** The adapter seam: one phase of tab work. */
export interface ActivityInfo {
  readonly kind: ActivityKind;
  readonly op: LiveOp;
}

/** The veil page's chip payload (veil.html is unchanged). */
export interface VeilInfo {
  kind: ActivityKind;
  label: string;
  count?: number;
  total?: number;
  detail?: string;
}

/** The live tab: the current phase (with when it began), whether a routine holds the page, and the hold names. */
export interface LiveTab {
  readonly activity: { readonly info: ActivityInfo; readonly since: number } | null;
  readonly busy: boolean;
  readonly holds: readonly string[];
}

const n = (v: number): string => v.toLocaleString('en-US');
const whose = (of: string | null, list: string): string => (of === null ? `your ${list}` : `@${of}'s ${list}`);
const PURPOSE = {
  'check-back': (u: string) => `Checking whether @${u} follows you back`,
  verify: (u: string) => `Double-checking @${u} before acting`,
  settle: (u: string) => `Confirming what happened with @${u}`,
  seed: (u: string) => `Checking @${u}`,
} as const;

/** An op's running count, for the ops that have one (a list read or a round of profile visits). */
export function liveOpProgress(op: LiveOp): { readonly done: number; readonly total: number | null } | null {
  switch (op.op) {
    case 'browse-list': case 'read-list': return { done: op.done, total: op.total };
    case 'visit-profiles': return { done: op.done, total: op.total };
    default: return null;
  }
}

/** The op's sentence without its running count: the veil's chip label, steady while the count moves. */
export function liveOpLead(op: LiveOp): string {
  switch (op.op) {
    case 'follow': return `Following @${op.username}`;
    case 'unfollow': return `Unfollowing @${op.username}`;
    case 'accept-request': return `Accepting @${op.username}'s follow request`;
    case 'open-list': return `Opening ${whose(op.of, op.list)}`;
    case 'browse-list': return `Scrolling ${whose(op.of, op.list)}`;
    case 'read-list': return `Reading ${whose(op.of, op.list)}`;
    case 'visit-profiles': return 'Looking at profiles';
    case 'visit-profile': return PURPOSE[op.purpose](op.username);
    case 'check-notifications': return 'Checking your notifications';
    case 'open-own-profile': return 'Opening your profile';
    case 'confirm-account': return 'Confirming your account';
  }
}

/**
 * One plain sentence per op, shared by the sidebar's now line and the veil ("Following @jane", "Reading
 * @studio.lumen's followers · 120 of 250"). The sidebar stream owns this wording.
 */
export function liveOpText(op: LiveOp): string {
  const p = liveOpProgress(op);
  if (p === null) return liveOpLead(op);
  return `${liveOpLead(op)} · ${p.total === null ? n(p.done) : `${n(p.done)} of ${n(p.total)}`}`;
}

/**
 * The veil's chip: the same sentence, with the running count beside it rather than inside the label, so the
 * veil's per-phase timer (keyed on the label) keeps running while a list read advances.
 */
export function toVeilInfo(info: ActivityInfo): VeilInfo {
  const p = liveOpProgress(info.op);
  const label = liveOpLead(info.op);
  if (p === null) return { kind: info.kind, label };
  return { kind: info.kind, label, count: p.done, ...(p.total === null ? {} : { total: p.total }) };
}
