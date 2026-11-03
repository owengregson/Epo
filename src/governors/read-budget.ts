import type { ReadAllowance } from '../kernel/derive-reads';
import type { Clock } from './clock';

export type ReadKind = 'profile' | 'list-page' | 'notification';
export type ReadPurpose = 'exploration' | 'reconciliation';
export interface ReadDebit { at: number; kind: ReadKind; purpose: ReadPurpose; count: number }
export interface ReadBudgetSnapshot { version: 1; debits: ReadDebit[] }
export interface ReadPermit { allowed: boolean; resumeAt: number | null }
/** The window's ceilings: derived from the live limits (kernel D6), never hardcoded. */
export type ReadBudgetConfig = ReadAllowance;

/** One account's deliberate reads. Reservations land before I/O; a restart cannot refund them. */
export class ReadBudget {
  constructor(private readonly deps: {
    store: { getReadBudgetState(): string | null; setReadBudgetState(raw: string | null): void };
    clock: Clock;
    /** Read on EVERY check: a settings change moves the allowance at once. */
    limits: () => ReadBudgetConfig;
  }) {}

  snapshot(): ReadBudgetSnapshot {
    const raw = this.deps.store.getReadBudgetState();
    if (raw === null) return { version: 1, debits: [] };
    const parsed = JSON.parse(raw) as ReadBudgetSnapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.debits) || parsed.debits.some((d) =>
      !Number.isFinite(d.at) || !Number.isSafeInteger(d.count) || d.count < 1 ||
      !['profile', 'list-page', 'notification'].includes(d.kind) ||
      !['exploration', 'reconciliation'].includes(d.purpose))) throw new Error('Invalid durable read budget');
    const { windowMs } = this.deps.limits();
    return { version: 1, debits: parsed.debits.filter((d) => d.at + windowMs > this.deps.clock.now()) };
  }

  availability(kind: ReadKind, purpose: ReadPurpose = 'exploration', count = 1): ReadPermit {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Read reservation must be positive');
    const state = this.snapshot();
    const cfg = this.deps.limits();
    const limit = kind === 'profile' ? cfg.profiles : kind === 'list-page' ? cfg.listPages : cfg.notifications;
    const groups = [{ rows: state.debits.filter((d) => d.kind === kind), limit }];
    if (kind === 'profile' && purpose === 'exploration') groups.push({
      rows: state.debits.filter((d) => d.kind === kind && d.purpose === 'exploration'), limit: cfg.explorationProfiles,
    });
    if (kind === 'list-page' && purpose === 'exploration') groups.push({
      rows: state.debits.filter((d) => d.kind === kind && d.purpose === 'exploration'), limit: cfg.explorationPages,
    });
    let resumeAt: number | null = null;
    for (const group of groups) {
      let used = group.rows.reduce((sum, d) => sum + d.count, 0);
      if (used + count <= group.limit) continue;
      let deadline = this.deps.clock.now() + cfg.windowMs;
      for (const debit of group.rows.sort((a, b) => a.at - b.at)) {
        used -= debit.count;
        deadline = debit.at + cfg.windowMs;
        if (used + count <= group.limit) break;
      }
      resumeAt = Math.max(resumeAt ?? 0, deadline);
    }
    return { allowed: resumeAt === null, resumeAt };
  }

  consume(kind: ReadKind, purpose: ReadPurpose = 'exploration', count = 1): ReadPermit {
    const permit = this.availability(kind, purpose, count);
    if (!permit.allowed) return permit;
    const state = this.snapshot();
    state.debits.push({ at: this.deps.clock.now(), kind, purpose, count });
    this.deps.store.setReadBudgetState(JSON.stringify(state));
    return permit;
  }
}
