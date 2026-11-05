import { RUNTIME_BOUNDS } from '@/kernel/runtime-bounds';
import type { KnowledgeStore } from '../store/knowledge-store';

export interface RuntimeHealthSnapshot {
  version: 1;
  consecutiveErrors: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastProgressAt: number | null;
  progressPhase: string | null;
}

/** Responsiveness and useful progress are independent. Error retries are bounded durably. */
export class RuntimeHealth {
  private state: RuntimeHealthSnapshot;
  constructor(private readonly store: Pick<KnowledgeStore, 'getLifecycleHealthState' | 'setLifecycleHealthState'>) {
    const raw = store.getLifecycleHealthState();
    const saved: Partial<RuntimeHealthSnapshot> | null = raw === null ? null : JSON.parse(raw);
    if (saved !== null && (saved.version !== 1 || !Number.isSafeInteger(saved.consecutiveErrors) || (saved.consecutiveErrors ?? -1) < 0
      || !(saved.lastError === null || typeof saved.lastError === 'string')
      || !(saved.progressPhase === null || typeof saved.progressPhase === 'string')
      || !(saved.lastErrorAt === null || Number.isFinite(saved.lastErrorAt))
      || !(saved.lastProgressAt === null || Number.isFinite(saved.lastProgressAt)))) {
      throw new Error('Invalid persisted lifecycle health');
    }
    this.state = saved as RuntimeHealthSnapshot ?? {
      version: 1, consecutiveErrors: 0, lastError: null, lastErrorAt: null,
      lastProgressAt: null, progressPhase: null,
    };
  }
  snapshot(): RuntimeHealthSnapshot { return { ...this.state }; }
  failure(error: unknown, now: number): boolean {
    this.state.consecutiveErrors++;
    this.state.lastError = String(error).slice(0, RUNTIME_BOUNDS.HEALTH_ERROR_CHARS);
    this.state.lastErrorAt = now;
    this.save();
    return this.state.consecutiveErrors >= RUNTIME_BOUNDS.HEALTH_ERROR_STREAK || /SQLITE|disk (?:full|I\/O)|database.*(?:corrupt|locked|closed)/i.test(String(error));
  }
  responsive(): void {
    if (this.state.consecutiveErrors === 0) return;
    this.state.consecutiveErrors = 0;
    this.save();
  }
  progress(phase: string, now: number): void {
    this.state.lastProgressAt = now;
    this.state.progressPhase = phase;
    this.save();
  }
  private save(): void { this.store.setLifecycleHealthState(JSON.stringify(this.state)); }
}
