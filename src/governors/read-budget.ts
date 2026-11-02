import type { Clock } from './clock';

export type ReadKind = 'profile' | 'list-page' | 'notification';
export type ReadPurpose = 'exploration' | 'reconciliation';
export interface ReadDebit { at: number; kind: ReadKind; purpose: ReadPurpose; count: number }
export interface ReadBudgetSnapshot { version: 1; debits: ReadDebit[] }
export interface ReadPermit { allowed: boolean; resumeAt: number | null }
export interface ReadBudgetConfig {
  windowMs: number;
  profiles: number;
  explorationProfiles: number;
  listPages: number;
  explorationPages: number;
  notifications: number;
}
/** Provisional ceilings no larger than the former single-pass limits. Not platform quotas. */
export const READ_BUDGET_DEFAULTS: ReadBudgetConfig = {
  windowMs: 24 * 60 * 60 * 1000,
  profiles: 80,
  explorationProfiles: 40,
  listPages: 200,
  explorationPages: 24,
  notifications: 24,
};

/** One account's deliberate reads. Reservations land before I/O; a restart cannot refund them. */
export class ReadBudget {
  private readonly cfg: ReadBudgetConfig;
  constructor(private readonly deps: {
    store: { getReadBudgetState(): string | null; setReadBudgetState(raw: string | null): void };
    clock: Clock;
    cfg?: Partial<ReadBudgetConfig>;
  }) { this.cfg = { ...READ_BUDGET_DEFAULTS, ...deps.cfg }; }

  snapshot(): ReadBudgetSnapshot {
    const raw = this.deps.store.getReadBudgetState();
    if (raw === null) return { version: 1, debits: [] };
    const parsed = JSON.parse(raw) as ReadBudgetSnapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.debits) || parsed.debits.some((d) =>
      !Number.isFinite(d.at) || !Number.isSafeInteger(d.count) || d.count < 1 ||
      !['profile', 'list-page', 'notification'].includes(d.kind) ||
      !['exploration', 'reconciliation'].includes(d.purpose))) throw new Error('Invalid durable read budget');
    return { version: 1, debits: parsed.debits.filter((d) => d.at + this.cfg.windowMs > this.deps.clock.now()) };
  }

  availability(kind: ReadKind, purpose: ReadPurpose = 'exploration', count = 1): ReadPermit {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Read reservation must be positive');
    const state = this.snapshot();
    const limit = kind === 'profile' ? this.cfg.profiles : kind === 'list-page' ? this.cfg.listPages : this.cfg.notifications;
    const groups = [{ rows: state.debits.filter((d) => d.kind === kind), limit }];
    if (kind === 'profile' && purpose === 'exploration') groups.push({
      rows: state.debits.filter((d) => d.kind === kind && d.purpose === 'exploration'), limit: this.cfg.explorationProfiles,
    });
    if (kind === 'list-page' && purpose === 'exploration') groups.push({
      rows: state.debits.filter((d) => d.kind === kind && d.purpose === 'exploration'), limit: this.cfg.explorationPages,
    });
    let resumeAt: number | null = null;
    for (const group of groups) {
      let used = group.rows.reduce((sum, d) => sum + d.count, 0);
      if (used + count <= group.limit) continue;
      let deadline = this.deps.clock.now() + this.cfg.windowMs;
      for (const debit of group.rows.sort((a, b) => a.at - b.at)) {
        used -= debit.count;
        deadline = debit.at + this.cfg.windowMs;
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
