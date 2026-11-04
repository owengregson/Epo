import { useEffect, useMemo, useState } from 'preact/hooks';
import { ChangeQueue, type QueueState } from '@/renderer/settings/change-queue';
import type { SettingsOp } from '@/shared/settings-ops';
import type { SettingsView } from '@/shared/settings-view';

export interface SettingsCommit {
  /** The newest view: a push or a save, whichever carries the higher rev. */
  readonly view: SettingsView | null;
  readonly state: QueueState;
  /** What a control shows: its pending change, else the view's value. */
  value<T>(key: string, fromView: T): T;
  /** Send a control's change now (no debounce); `shown` is what the control shows until it settles. */
  commit(key: string, ops: readonly SettingsOp[], shown?: unknown): void;
  pending(key: string): boolean;
  error(key: string): string | null;
  undo(): void;
  retry(): void;
  dismissConflicts(): void;
}

/** The stage's one change queue (spec §6.8), fed every view the shell receives. */
export function useSettingsCommit(view: SettingsView | null): SettingsCommit {
  const queue = useMemo(() => {
    const q = new ChangeQueue((ops) => window.epo.applySettings(ops));
    q.adopt(view);
    return q;
    // The queue lives as long as the stage; later views arrive through `adopt` below.
  }, []);
  const [state, setState] = useState<QueueState>(() => queue.state());

  useEffect(() => queue.subscribe(setState), [queue]);
  useEffect(() => queue.adopt(view), [queue, view]);

  return useMemo<SettingsCommit>(
    () => ({
      view: state.view ?? view,
      state,
      value: (key, fromView) => queue.valueOf(key, fromView),
      commit: (key, ops, shown) => queue.submit(key, ops, shown),
      pending: (key) => state.overlay.has(key),
      error: (key) => state.errors.get(key) ?? null,
      undo: () => queue.undo(),
      retry: () => queue.retry(),
      dismissConflicts: () => queue.dismissConflicts(),
    }),
    [queue, state, view],
  );
}
