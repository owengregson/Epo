import * as logger from '../utils/logger';

/** Observable graph updates become visible only after their enclosing write commits. */
export class MutationPulse {
  private readonly listeners = new Set<() => void>();
  private depth = 0;
  private pending = false;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  changed(): void {
    if (this.depth > 0) { this.pending = true; return; }
    for (const listener of [...this.listeners]) {
      try { listener(); }
      catch (error) { logger.error('store.onMutation listener threw', { error: String(error) }); }
    }
  }

  atomic<T>(write: () => T): T {
    const wasPending = this.pending;
    this.depth++;
    let committed = false;
    try {
      const result = write();
      committed = true;
      return result;
    } finally {
      this.depth--;
      if (!committed) this.pending = wasPending;
      if (this.depth === 0) {
        const notify = committed && this.pending;
        this.pending = false;
        if (notify) this.changed();
      }
    }
  }
}
