import type { PlanReadAllowance } from '../kernel/derive-reads';
import type { ReadUse } from '../kernel/plan/types';
import { MS_PER_DAY } from '../kernel/units';
import type { Clock } from './clock';

export type ReadKind = 'profile' | 'list-page' | 'notification';
export type ReadPurpose = 'exploration' | 'reconciliation';
export interface ReadDebit { at: number; kind: ReadKind; purpose: ReadPurpose; count: number; use?: ReadUse }
export interface ReadBudgetSnapshot { version: 1; debits: ReadDebit[] }
export interface ReadPermit { allowed: boolean; resumeAt: number | null }

/**
 * The limits on every check (kernel D6, spec §5.8 layer 1): the plan-day totals with the verify reserve,
 * the plan-day window they reset at, and the plan's explore sub-limit. Every total also binds any trailing
 * 24 h (spec §3 deviation 3), so reads at any hour never spend two days' totals around a boundary.
 */
export type ReadBudgetConfig = PlanReadAllowance & {
  readonly window?: { readonly startsAt: number; readonly endsAt: number } | null;
  readonly explore?: { readonly profiles: number; readonly pages: number } | null;
};

/** The trailing backstop's span: the totals' own day. */
const BACKSTOP_MS = MS_PER_DAY;

/** One account's deliberate reads. Reservations land before I/O; a restart cannot refund them. */
export class ReadBudget {
  constructor(private readonly deps: {
    store: { getReadBudgetState(): string | null; setReadBudgetState(raw: string | null): void };
    clock: Clock;
    /** Read on EVERY check: a settings change or a new plan-day moves the allowance at once. */
    limits: () => ReadBudgetConfig;
  }) {}

  /** The debits still inside the plan-day or the trailing backstop (older ones can bind neither). */
  snapshot(): ReadBudgetSnapshot {
    const raw = this.deps.store.getReadBudgetState();
    if (raw === null) return { version: 1, debits: [] };
    const parsed = JSON.parse(raw) as ReadBudgetSnapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.debits) || parsed.debits.some((d) =>
      !Number.isFinite(d.at) || !Number.isSafeInteger(d.count) || d.count < 1 ||
      !['profile', 'list-page', 'notification'].includes(d.kind) ||
      !['exploration', 'reconciliation'].includes(d.purpose))) throw new Error('Invalid durable read budget');
    const now = this.deps.clock.now();
    const from = Math.min(now - BACKSTOP_MS, this.deps.limits().window?.startsAt ?? now);
    return { version: 1, debits: parsed.debits.filter((d) => d.at > from) };
  }

  /**
   * Whether `count` more reads of `kind` fit: the total, the exploration sub-limits and (for a profile read not
   * spent on verification) the room outside the verify reserve, each per plan-day and over the trailing 24 h.
   * A refusal's `resumeAt` is the latest instant one of them reopens: the boundary, or the trailing expiry.
   */
  availability(kind: ReadKind, purpose: ReadPurpose = 'exploration', count = 1, use?: ReadUse): ReadPermit {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Read reservation must be positive');
    const debits = this.snapshot().debits.filter((d) => d.kind === kind);
    const cfg = this.deps.limits();
    const limit = kind === 'profile' ? cfg.profiles : kind === 'list-page' ? cfg.listPages : cfg.notifications;
    const groups: { rows: ReadDebit[]; limit: number }[] = [{ rows: debits, limit }];
    const explore = (rows: ReadDebit[], d6: number, plan: number | undefined) =>
      groups.push({ rows: rows.filter((d) => d.purpose === 'exploration'), limit: Math.min(d6, plan ?? d6) });
    if (purpose === 'exploration' && kind === 'profile') explore(debits, cfg.explorationProfiles, cfg.explore?.profiles);
    if (purpose === 'exploration' && kind === 'list-page') explore(debits, cfg.explorationPages, cfg.explore?.pages);
    // Click-time verification always fits (spec §5.8): every other profile read leaves the reserve untouched.
    if (kind === 'profile' && use !== 'verify') {
      groups.push({ rows: debits.filter((d) => d.use !== 'verify'), limit: Math.max(0, cfg.profiles - cfg.verifyReserve) });
    }
    const now = this.deps.clock.now();
    const window = cfg.window ?? null;
    const reopens: number[] = [];
    for (const group of groups) {
      if (window !== null) {
        const today = group.rows.filter((d) => d.at >= window.startsAt).reduce((n, d) => n + d.count, 0);
        if (today + count > group.limit) reopens.push(window.endsAt);
      }
      const trailing = group.rows.filter((d) => d.at > now - BACKSTOP_MS).sort((a, b) => a.at - b.at);
      let used = trailing.reduce((n, d) => n + d.count, 0);
      if (used + count <= group.limit) continue;
      let expiry = now + BACKSTOP_MS;
      for (const debit of trailing) {
        used -= debit.count;
        expiry = debit.at + BACKSTOP_MS;
        if (used + count <= group.limit) break;
      }
      reopens.push(expiry);
    }
    return reopens.length === 0 ? { allowed: true, resumeAt: null } : { allowed: false, resumeAt: Math.max(...reopens) };
  }

  /** The reads debited since `since`, by kind (the plan projection's "done"). */
  doneSince(since: number): { readonly profiles: number; readonly pages: number; readonly checks: number } {
    const sum = (kind: ReadKind): number => this.snapshot().debits
      .filter((d) => d.kind === kind && d.at >= since).reduce((n, d) => n + d.count, 0);
    return { profiles: sum('profile'), pages: sum('list-page'), checks: sum('notification') };
  }

  /** `use` tags the debit with what the read is for (an optional field the v1 snapshot shape ignores). */
  consume(kind: ReadKind, purpose: ReadPurpose = 'exploration', count = 1, use?: ReadUse): ReadPermit {
    const permit = this.availability(kind, purpose, count, use);
    if (!permit.allowed) return permit;
    const state = this.snapshot();
    state.debits.push({ at: this.deps.clock.now(), kind, purpose, count, ...(use === undefined ? {} : { use }) });
    this.deps.store.setReadBudgetState(JSON.stringify(state));
    return permit;
  }
}
