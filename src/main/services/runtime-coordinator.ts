import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUNTIME_BOUNDS } from '@/kernel/runtime-bounds';

/** The repair budget and the incident tail (`RUNTIME_BOUNDS`; the window spans several watchdog windows). */
const { REPAIR_WINDOW_MS, REPAIR_LIMIT, INCIDENTS_KEPT } = RUNTIME_BOUNDS;

export type RunIntent = 'stopped' | 'paused' | 'running';
export type RuntimePhase = 'ready' | 'suspended' | 'reconciling' | 'recovering';
export interface RuntimeIncident {
  at: number;
  reason: string;
  detail?: string;
}
export interface RuntimeSnapshot {
  version: 1;
  desired: RunIntent;
  accountPk: string | null;
  legacyAccountPk: string | null;
  blockedReason: string | null;
  recoveryAttempts: number[];
  incidents: RuntimeIncident[];
  updatedAt: number;
  phase: RuntimePhase;
  lastProgressAt: number;
  progressPhase: string | null;
}

/** Durable intent is separate from transient execution. A command revokes every
 * older automatic continuation; a repair consumes a persistent, bounded budget. */
export class RuntimeCoordinator {
  private state: Omit<RuntimeSnapshot, 'phase' | 'lastProgressAt' | 'progressPhase'>;
  private phase: RuntimePhase = 'ready';
  private epoch = 0;
  private activityAbort = new AbortController();
  private recovery: Promise<void> | null = null;
  private lastProgressAt: number;
  private progressPhase: string | null = null;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.lastProgressAt = now();
    this.state = {
      version: 1, desired: 'stopped', accountPk: null, legacyAccountPk: null,
      blockedReason: null, recoveryAttempts: [], incidents: [], updatedAt: now(),
    };
    if (!fs.existsSync(file)) return;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeSnapshot>;
      if (value.version !== 1 || !['stopped', 'paused', 'running'].includes(value.desired ?? '')) {
        throw new Error('Invalid runtime state');
      }
      this.state = {
        ...this.state,
        desired: value.desired as RunIntent,
        accountPk: typeof value.accountPk === 'string' ? value.accountPk : null,
        legacyAccountPk: typeof value.legacyAccountPk === 'string' ? value.legacyAccountPk : null,
        blockedReason: typeof value.blockedReason === 'string' ? value.blockedReason : null,
        recoveryAttempts: (value.recoveryAttempts ?? []).filter((at) => Number.isFinite(at)),
        incidents: (value.incidents ?? []).filter((i) => Number.isFinite(i.at) && typeof i.reason === 'string').slice(-INCIDENTS_KEPT),
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now(),
      };
    } catch (error) {
      this.state.blockedReason = 'runtime-state-unreadable';
      this.state.incidents.push({ at: now(), reason: 'runtime-state-unreadable', detail: String(error) });
    }
  }

  snapshot(): RuntimeSnapshot {
    return { ...this.state, recoveryAttempts: [...this.state.recoveryAttempts],
      incidents: this.state.incidents.map((i) => ({ ...i })), phase: this.phase,
      lastProgressAt: this.lastProgressAt, progressPhase: this.progressPhase };
  }

  token(): number { return this.epoch; }
  current(token: number): boolean { return token === this.epoch; }
  signal(): AbortSignal { return this.activityAbort.signal; }
  ready(): boolean { return this.phase === 'ready' && this.state.blockedReason === null; }
  wantsRun(token = this.epoch): boolean {
    return this.current(token) && this.state.desired === 'running' && this.ready();
  }

  command(desired: RunIntent): number {
    this.epoch += 1;
    this.state.desired = desired;
    if (desired === 'running') this.state.blockedReason = null;
    this.persist();
    return this.epoch;
  }

  bindAccount(pk: string): string {
    if (this.state.legacyAccountPk === null) {
      this.state.legacyAccountPk = pk;
      this.persist();
    }
    return pk === this.state.legacyAccountPk ? 'epo.db' : `epo-account-${encodeURIComponent(pk)}.db`;
  }

  authorizeAccount(pk: string): void {
    this.state.accountPk = pk;
    this.persist();
  }

  suspend(): void {
    this.epoch += 1;
    this.phase = 'suspended';
    this.activityAbort.abort();
    this.record('system-suspended');
  }

  beginWake(): number {
    this.phase = 'reconciling';
    return this.epoch;
  }

  finishWake(token: number): void {
    // A user Stop changes intent, not whether the completed wake checks are
    // valid. A newer suspend DOES invalidate them and keeps admission closed.
    if (this.phase !== 'reconciling') return;
    this.activityAbort = new AbortController();
    this.phase = 'ready';
    this.record('system-reconciled', this.current(token) ? undefined : 'Run intent changed during reconciliation');
  }

  block(reason: string, detail?: string): void {
    this.epoch += 1;
    this.state.blockedReason = reason;
    this.activityAbort.abort();
    this.record(reason, detail);
  }

  acknowledge(): void {
    this.activityAbort = new AbortController();
    this.progress('run-start');
  }

  resetData(): void {
    this.epoch += 1;
    this.activityAbort.abort();
    this.activityAbort = new AbortController();
    this.phase = 'ready';
    this.state.desired = 'stopped';
    this.state.accountPk = null;
    this.state.legacyAccountPk = null;
    this.state.blockedReason = null;
    this.state.recoveryAttempts = [];
    this.record('data-cleared');
  }

  progress(phase: string): void {
    this.lastProgressAt = this.now();
    this.progressPhase = phase;
  }

  /** All repair callers share one flight. Success is not proof of sustained
   * health: attempts age out after an hour, rather than resetting on reload. */
  repair(reason: string, run: () => Promise<void>): Promise<void> {
    if (this.recovery !== null) return this.recovery;
    const now = this.now();
    this.state.recoveryAttempts = this.state.recoveryAttempts.filter((at) => now - at < REPAIR_WINDOW_MS);
    if (this.state.recoveryAttempts.length >= REPAIR_LIMIT) {
      this.block('runtime-recovery-exhausted', reason);
      return Promise.reject(new Error('runtime-recovery-exhausted'));
    }
    this.state.recoveryAttempts.push(now);
    this.record('runtime-recovery-attempt', reason);
    if (this.state.blockedReason === 'runtime-state-persist-failed') return Promise.reject(new Error('runtime-state-persist-failed'));
    const priorPhase = this.phase;
    this.phase = 'recovering';
    const task = Promise.resolve().then(run).then(() => {
      this.record('runtime-recovery-complete', reason);
    }, (error: unknown) => {
      this.record('runtime-recovery-failed', `${reason}: ${String(error)}`);
      throw error;
    }).finally(() => {
      if (this.phase === 'recovering') this.phase = priorPhase;
      this.recovery = null;
    });
    this.recovery = task;
    return task;
  }

  record(reason: string, detail?: string): void {
    this.state.incidents.push({ at: this.now(), reason, ...(detail === undefined ? {} : { detail }) });
    this.state.incidents = this.state.incidents.slice(-INCIDENTS_KEPT);
    this.persist();
  }

  private persist(): void {
    this.state.updatedAt = this.now();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      // Storage failure must refuse new activity without preventing Stop from
      // reaching the engine. The incident remains visible in this process.
      this.state.blockedReason = 'runtime-state-persist-failed';
      this.state.incidents = [...this.state.incidents, {
        at: this.now(), reason: 'runtime-state-persist-failed', detail: String(error),
      }].slice(-INCIDENTS_KEPT);
      this.activityAbort.abort();
    }
  }
}
