import { RUNTIME_BOUNDS } from '@/kernel/runtime-bounds';
import * as logger from '@/utils/logger';

const { DASHBOARD_LOAD_MS, DASHBOARD_RELOADS, DASHBOARD_RELOAD_WINDOW_MS, DASHBOARD_RELOAD_STEP_MS } = RUNTIME_BOUNDS;

interface DashboardRecoveryDeps {
  load(): Promise<void>;
  available(): boolean;
  blocked(reason: string): void;
}

/** A lost control surface gets a bounded number of reloads per window, then stops work.
 * Neither a hung load nor a failed initial load may leave an invisible run. */
export class DashboardRecovery {
  private attempts: number[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private stopped = false;

  constructor(private readonly deps: DashboardRecoveryDeps) {}

  load(): void {
    if (this.stopped || !this.deps.available()) return;
    const generation = ++this.generation;
    this.clearDeadline();
    this.deadline = setTimeout(() => this.failed('load-timeout'), DASHBOARD_LOAD_MS);
    void Promise.resolve().then(() => this.deps.load()).then(() => {
      if (generation === this.generation) this.clearDeadline();
    }, (error: unknown) => {
      if (generation === this.generation) this.failed(`load-failed: ${String(error)}`);
    });
  }

  failed(reason: string): void {
    if (this.stopped || !this.deps.available() || this.retry !== null) return;
    this.generation++;
    this.clearDeadline();
    const now = Date.now();
    this.attempts = this.attempts.filter((at) => now - at < DASHBOARD_RELOAD_WINDOW_MS);
    logger.error('shell: dashboard unavailable', { reason, attempts: this.attempts.length });
    if (this.attempts.length >= DASHBOARD_RELOADS) {
      this.stop();
      this.deps.blocked('dashboard-recovery-exhausted');
      return;
    }
    this.attempts.push(now);
    this.retry = setTimeout(() => { this.retry = null; this.load(); }, this.attempts.length * DASHBOARD_RELOAD_STEP_MS);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.clearDeadline();
  }

  private clearDeadline(): void {
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
  }
}
