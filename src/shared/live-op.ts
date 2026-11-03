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
const progress = (done: number, total: number | null): string => (total === null ? n(done) : `${n(done)} of ${n(total)}`);
const PURPOSE = {
  'check-back': (u: string) => `Checking whether @${u} follows you back`,
  verify: (u: string) => `Double-checking @${u} before acting`,
  settle: (u: string) => `Confirming what happened with @${u}`,
  seed: (u: string) => `Checking @${u}`,
} as const;

/** One plain sentence per op, for the sidebar's now line (the sidebar stream owns this wording). */
export function liveOpText(op: LiveOp): string {
  switch (op.op) {
    case 'follow': return `Following @${op.username}`;
    case 'unfollow': return `Unfollowing @${op.username}`;
    case 'accept-request': return `Accepting @${op.username}'s follow request`;
    case 'open-list': return `Opening ${whose(op.of, op.list)}`;
    case 'browse-list': return `Scrolling ${whose(op.of, op.list)} · ${progress(op.done, op.total)}`;
    case 'read-list': return `Reading ${whose(op.of, op.list)} · ${progress(op.done, op.total)}`;
    case 'visit-profiles': return `Looking at profiles · ${progress(op.done, op.total)}`;
    case 'visit-profile': return PURPOSE[op.purpose](op.username);
    case 'check-notifications': return 'Checking your notifications';
    case 'open-own-profile': return 'Opening your profile';
    case 'confirm-account': return 'Confirming your account';
  }
}

const listWord = (list: 'followers' | 'following'): string => (list === 'following' ? 'following' : 'follower');

/** The veil's chip: the labels the reporter sites have always shown; ops without one show their sentence. */
export function toVeilInfo(info: ActivityInfo): VeilInfo {
  const { kind, op } = info;
  switch (op.op) {
    case 'follow': return { kind, label: `Following @${op.username}` };
    case 'unfollow': return { kind, label: `Unfollowing @${op.username}` };
    case 'open-list': return { kind, label: `Opening ${op.list} list · @${op.of}` };
    case 'check-notifications': return { kind, label: 'Checking notifications' };
    case 'visit-profiles': return { kind, label: 'Visiting profiles', count: op.done, total: op.total };
    case 'browse-list': return { kind, label: `Scrolling ${listWord(op.list)} list`, count: op.done,
      ...(op.total === null ? {} : { total: op.total }), ...(op.of === null ? {} : { detail: `@${op.of}` }) };
    case 'read-list': return { kind, label: `Reading ${listWord(op.list)} list`, count: op.done,
      ...(op.total === null ? {} : { total: op.total }) };
    default: return { kind, label: liveOpText(op) };
  }
}
