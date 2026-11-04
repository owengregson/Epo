/**
 * The Settings change queue (spec §6.8): an optimistic overlay per control key, sends one at a time and
 * coalesced per key, never debounced. A saved result adopts its view by rev and offers Undo; a failed one
 * reverts that key and says nothing was changed. Pushes older than the adopted view are ignored, and
 * pending overlays stay on top of a newer one. Framework-free.
 */
import type { OverrideConflict, SettingsOp, SettingsSaveResult } from '@/shared/settings-ops';
import type { SettingsView } from '@/shared/settings-view';

/** What the header's save status says. */
export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly key: string; readonly inverse: readonly SettingsOp[]; readonly adjusted: number }
  | { readonly kind: 'failed'; readonly detail: string; readonly reason: 'not-saved' | 'refused' | 'unreachable' };

export interface QueueState {
  /** The adopted view: the newest rev seen from a pull, a push or a save. */
  readonly view: SettingsView | null;
  /** Control key → the value shown while its change is unsent or in flight. */
  readonly overlay: ReadonlyMap<string, unknown>;
  /** Control key → why its last change was not saved (cleared by its next change). */
  readonly errors: ReadonlyMap<string, string>;
  /** Overrides whose recommendation the last save moved ("You set … yourself"). */
  readonly conflicts: readonly OverrideConflict[];
  readonly save: SaveState;
}

interface Change {
  readonly key: string;
  readonly ops: readonly SettingsOp[];
  readonly seq: number;
}

export type SendFn = (ops: readonly SettingsOp[]) => Promise<SettingsSaveResult>;

/** The undo change's key: it has no control of its own. */
const UNDO_KEY = 'undo';

export class ChangeQueue {
  private view: SettingsView | null = null;
  private readonly overlay = new Map<string, unknown>();
  private readonly errors = new Map<string, string>();
  private conflicts: readonly OverrideConflict[] = [];
  private save: SaveState = { kind: 'idle' };
  private readonly queued: Change[] = [];
  private inFlight: Change | null = null;
  private failed: Change | null = null;
  private seq = 0;
  /** The newest submission per key: only it may clear the key's overlay. */
  private readonly latest = new Map<string, number>();
  private readonly listeners = new Set<(s: QueueState) => void>();

  constructor(private readonly send: SendFn) {}

  state(): QueueState {
    return { view: this.view, overlay: this.overlay, errors: this.errors, conflicts: this.conflicts, save: this.save };
  }

  subscribe(fn: (s: QueueState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Document rev rejects older settings; equal rev can carry new startup capabilities or preview data. */
  adopt(view: SettingsView | null): void {
    if (view === null || view === this.view || (this.view !== null && view.rev < this.view.rev)) return;
    this.view = view;
    this.emit();
  }

  /** The value a control shows: its pending change, else the view's. */
  valueOf<T>(key: string, fromView: T): T {
    return this.overlay.has(key) ? (this.overlay.get(key) as T) : fromView;
  }

  /** Queue a change for one control; an unsent change for the same key is replaced (coalesced). */
  submit(key: string, ops: readonly SettingsOp[], shown?: unknown): void {
    if (ops.length === 0) return;
    this.seq += 1;
    const change: Change = { key, ops, seq: this.seq };
    this.latest.set(key, change.seq);
    this.errors.delete(key);
    if (shown !== undefined) this.overlay.set(key, shown);
    const at = this.queued.findIndex((c) => c.key === key);
    if (at >= 0) this.queued.splice(at, 1, change);
    else this.queued.push(change);
    this.emit();
    this.pump();
  }

  /** Send the last saved change's inverse ops (Undo). */
  undo(): void {
    if (this.save.kind === 'saved' && this.save.inverse.length > 0) this.submit(UNDO_KEY, this.save.inverse);
  }

  /** Send the change that failed again (the header's Try again). */
  retry(): void {
    const f = this.failed;
    if (f !== null) this.submit(f.key, f.ops);
  }

  dismissConflicts(): void {
    this.conflicts = [];
    this.emit();
  }

  private pump(): void {
    if (this.inFlight !== null) return;
    const next = this.queued.shift();
    if (next === undefined) return;
    this.inFlight = next;
    this.save = { kind: 'saving' };
    this.emit();
    this.send(next.ops).then(
      (r) => this.settle(next, r),
      (e: unknown) => this.settle(next, null, e instanceof Error ? e.message : String(e)),
    );
  }

  private settle(c: Change, r: SettingsSaveResult | null, error?: string): void {
    this.inFlight = null;
    const newest = this.latest.get(c.key) === c.seq;
    if (r !== null && r.kind === 'saved') {
      if (r.view.rev >= (this.view?.rev ?? -1)) this.view = r.view;
      if (newest) this.overlay.delete(c.key);
      this.failed = null;
      this.conflicts = r.conflicts;
      this.save = { kind: 'saved', key: c.key, inverse: r.inverse, adjusted: r.adjustments.length };
    } else {
      // Nothing changed in main: the control goes back to what the view says.
      if (newest) this.overlay.delete(c.key);
      const detail = r === null ? (error ?? 'no answer') : r.detail;
      this.errors.set(c.key, detail);
      this.failed = c;
      this.save = { kind: 'failed', detail, reason: r === null ? 'unreachable' : r.kind };
    }
    this.emit();
    this.pump();
  }

  private emit(): void {
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }
}
