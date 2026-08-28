import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Settings } from '@/types';
import { ceilFor, planFor } from '../lib/settings-derive';
import { type Aggressiveness, detectPreset, presetPatch } from '../lib/strategy-presets';

/** Debounce before persisting an edit (settings apply live — spec §3). */
export const AUTOSAVE_MS = 600;
/** How long the "Saved" chip lingers before decaying back to idle. */
export const SAVED_TTL_MS = 1800;

/**
 * Autosave lifecycle, rendered by the Settings surface chip:
 * - 'saving' — edits are pending (debounce armed) or a save is in flight;
 * - 'saved'  — the last save landed and nothing is pending (decays to 'idle');
 * - 'error'  — the last save was REJECTED; the edited keys are still unsaved.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** The environment {@link SettingsAutosave} writes through (the hook wires the real one). */
export interface AutosaveHost {
  /** Freshest draft — read at debounce-fire time, not at edit time. */
  getDraft(): Settings | null;
  /** Persist the edited keys; resolves with the canonical saved Settings. */
  save(partial: Partial<Settings>): Promise<Settings>;
  /** A save RESOLVED — adopt the canonical result. */
  onSaved(saved: Settings): void;
  /** A save REJECTED — the edited keys stay unsaved (the caller surfaces this). */
  onSaveError(error: unknown): void;
  /** The lifecycle state changed (drives the Saving…/Saved/Not saved chip). */
  onState(state: SaveState): void;
}

/**
 * Framework-free autosave core for the Settings draft. Debounces edits, sends
 * ONLY the edited keys, and — the load-bearing part — keeps those keys marked
 * unsaved until the save actually RESOLVES. A rejected save merges its keys
 * back into the dirty set, so the draft and the chip tell the truth and the
 * next edit retries everything still unsaved. (The old code cleared the dirty
 * set before the IPC settled, so a failed save silently reverted the edit.)
 */
export class SettingsAutosave {
  private dirty = new Set<keyof Settings>();
  /** Keys sent but not yet settled; on rejection they return to `dirty`. */
  private inFlight: Set<keyof Settings> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private savedDecay: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by reset/dispose; an in-flight save from an older epoch settles as a no-op. */
  private epoch = 0;

  constructor(private readonly host: AutosaveHost) {}

  /** Mark keys edited and (re)arm the debounce. */
  markDirty(keys: Iterable<keyof Settings>): void {
    for (const k of keys) this.dirty.add(k);
    if (this.dirty.size === 0) return;
    this.clearSavedDecay();
    this.host.onState('saving');
    this.schedule();
  }

  /**
   * Keys the user edited that are not yet confirmed persisted (dirty or mid-save).
   * External settings merges must preserve these — everything else may be adopted.
   */
  editedKeys(): ReadonlySet<keyof Settings> {
    if (this.inFlight === null) return this.dirty;
    const union = new Set(this.dirty);
    for (const k of this.inFlight) union.add(k);
    return union;
  }

  /**
   * Drop every pending edit and timer (the draft was replaced wholesale, e.g. a
   * settings reset that already persisted). A save still in flight settles silently.
   */
  reset(): void {
    this.epoch += 1;
    this.dirty.clear();
    this.inFlight = null;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.clearSavedDecay();
    this.host.onState('idle');
  }

  /** Unmount: cancel timers; a save already in flight settles silently. */
  dispose(): void {
    this.epoch += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.clearSavedDecay();
  }

  private clearSavedDecay(): void {
    if (this.savedDecay !== undefined) clearTimeout(this.savedDecay);
    this.savedDecay = undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), AUTOSAVE_MS);
  }

  private fire(): void {
    this.timer = undefined;
    const draft = this.host.getDraft();
    if (draft === null || this.dirty.size === 0) return;
    if (this.inFlight !== null) {
      // A save is still settling — stay debounced behind it (saves serialize,
      // so a rejection can hand its keys back before the retry reads them).
      this.schedule();
      return;
    }
    const sending = this.dirty;
    this.dirty = new Set();
    this.inFlight = sending;
    const partial: Partial<Settings> = {};
    for (const k of sending) {
      (partial as unknown as Record<string, unknown>)[k] = draft[k];
    }
    const epoch = this.epoch;
    this.host.onState('saving');
    this.host.save(partial).then(
      (saved) => {
        if (epoch !== this.epoch) return; // superseded by reset()/dispose()
        this.inFlight = null;
        this.host.onSaved(saved);
        if (this.dirty.size === 0) {
          this.host.onState('saved');
          this.savedDecay = setTimeout(() => {
            this.savedDecay = undefined;
            this.host.onState('idle');
          }, SAVED_TTL_MS);
        }
        // else newer edits already re-armed the debounce — stay 'saving'.
      },
      (error: unknown) => {
        if (epoch !== this.epoch) return; // superseded by reset()/dispose()
        // The fix for the silent revert: a rejected save keeps its keys marked
        // unsaved (values live on in the draft), so the next edit retries them.
        for (const k of sending) this.dirty.add(k);
        this.inFlight = null;
        this.host.onState('error');
        this.host.onSaveError(error);
      },
    );
  }
}

export interface SettingsDraftController {
  draft: Settings | null;
  preset: Aggressiveness;
  /** Autosave lifecycle for the surface chip (Saving… / Saved / Not saved). */
  saveState: SaveState;
  /** True while a non-Custom preset locks the rate/delay/jitter knobs. */
  locked: boolean;
  /** Update one field (autosaves). */
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  /** Merge several fields at once (autosaves). */
  patch(part: Partial<Settings>): void;
  /** Daily-activity master: also re-derives the hard ceiling + daily plan. */
  setRate(rate: number): void;
  /** Select an aggressiveness preset (writes knobs) or 'custom' (just unlocks). */
  setPreset(next: Aggressiveness): void;
  /**
   * Adopt an externally-changed Settings object (e.g. after a settings reset that
   * already persisted). Replaces the draft + preset WITHOUT re-saving.
   */
  replace(next: Settings): void;
}

/**
 * Owns the editable Settings draft for the Settings view. Every change is merged
 * into the draft and autosaved (debounced) through `settings:update`, which
 * persists and reloads the engine's derived configs. The daily-activity rate is
 * the single master (hard ceiling + daily plan derive from it), and the strategy
 * preset locks rate/delay/jitter until Custom is chosen. Save failures surface
 * through `onSaveError` (the view routes them to the shell toast) and leave the
 * edited keys unsaved — see {@link SettingsAutosave}.
 */
export function useSettingsDraft(
  initial: Settings | null,
  onSaved: (s: Settings) => void,
  onSaveError?: (error: unknown) => void,
): SettingsDraftController {
  const [draft, setDraft] = useState<Settings | null>(initial);
  const [preset, setPreset] = useState<Aggressiveness>(() =>
    initial ? detectPreset(initial) : 'balanced',
  );
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;
  /** Freshest draft (the debounced save reads it at fire time, not capture time). */
  const draftRef = useRef<Settings | null>(draft);
  draftRef.current = draft;

  /**
   * The autosave core. It tracks the keys the USER edited since their last
   * CONFIRMED save — the debounced autosave sends ONLY these. Saving the whole
   * draft used to silently revert every setting written outside this view (the
   * Prune view's partials, backend-owned `pruneLastRunAt`/`sweepLastRunAt`) to
   * whatever this view last saw.
   */
  const autosave = useMemo(
    () =>
      new SettingsAutosave({
        getDraft: () => draftRef.current,
        save: (partial) => window.epo.updateSettings(partial),
        onSaved: (saved) => onSavedRef.current(saved),
        onSaveError: (error) => onSaveErrorRef.current?.(error),
        onState: setSaveState,
      }),
    [],
  );

  // Adopt externally-changed settings: first arrival wholesale; afterwards,
  // merge external values for every key the user is NOT currently editing —
  // so a prune-view save (or a backend write) can never be clobbered here.
  useEffect(() => {
    if (initial === null) return;
    setDraft((prev) => {
      if (prev === null) {
        setPreset(detectPreset(initial));
        return initial;
      }
      const merged: Settings = { ...initial };
      for (const k of autosave.editedKeys()) {
        (merged as unknown as Record<string, unknown>)[k] = prev[k];
      }
      return merged;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(() => () => autosave.dispose(), [autosave]);

  const patch = useCallback(
    (part: Partial<Settings>) => {
      if (draftRef.current === null) return;
      autosave.markDirty(Object.keys(part) as Array<keyof Settings>);
      setDraft((prev) => (prev === null ? prev : { ...prev, ...part }));
    },
    [autosave],
  );

  const set = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      patch({ [key]: value } as unknown as Partial<Settings>);
    },
    [patch],
  );

  const setRate = useCallback(
    (rate: number) => {
      patch({ dailyOperatingRate: rate, dailyHardCeiling: ceilFor(rate), dailyPlanSize: planFor(rate) });
    },
    [patch],
  );

  const setPresetCb = useCallback(
    (next: Aggressiveness) => {
      if (next === 'custom') {
        setPreset('custom');
        return;
      }
      const p = presetPatch(next);
      patch({
        ...p,
        dailyHardCeiling: ceilFor(p.dailyOperatingRate),
        dailyPlanSize: planFor(p.dailyOperatingRate),
      });
      setPreset(next);
    },
    [patch],
  );

  const replace = useCallback(
    (next: Settings) => {
      autosave.reset(); // pending edits are superseded — nothing to save
      setDraft(next);
      setPreset(detectPreset(next));
    },
    [autosave],
  );

  return {
    draft,
    preset,
    saveState,
    locked: preset !== 'custom',
    set,
    patch,
    setRate,
    setPreset: setPresetCb,
    replace,
  };
}
