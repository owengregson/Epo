import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Settings } from '@/types';
import { ceilFor, planFor } from '../lib/settings-derive';
import { type Aggressiveness, detectPreset, presetPatch } from '../lib/strategy-presets';

/** Debounce before persisting an edit (settings apply live — spec §3). */
const AUTOSAVE_MS = 600;

export interface SettingsDraftController {
  draft: Settings | null;
  preset: Aggressiveness;
  saving: boolean;
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
 * preset locks rate/delay/jitter until Custom is chosen.
 */
export function useSettingsDraft(
  initial: Settings | null,
  onSaved: (s: Settings) => void,
): SettingsDraftController {
  const [draft, setDraft] = useState<Settings | null>(initial);
  const [preset, setPreset] = useState<Aggressiveness>(() =>
    initial ? detectPreset(initial) : 'balanced',
  );
  const [saving, setSaving] = useState(false);
  const timer = useRef<number | undefined>();
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  /** Freshest draft (the debounced save reads it at fire time, not capture time). */
  const draftRef = useRef<Settings | null>(draft);
  draftRef.current = draft;
  /**
   * Keys the USER edited since the last save — the debounced autosave sends
   * ONLY these. Saving the whole draft used to silently revert every setting
   * written outside this view (the Prune view's partials, backend-owned
   * `pruneLastRunAt`/`sweepLastRunAt`) to whatever this view last saw.
   */
  const dirty = useRef(new Set<keyof Settings>());

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
      for (const k of dirty.current) {
        (merged as unknown as Record<string, unknown>)[k] = prev[k];
      }
      return merged;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const scheduleSave = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const current = draftRef.current;
      if (current === null || dirty.current.size === 0) return;
      // Send ONLY the edited keys; the backend merges over its own canon.
      const partial: Partial<Settings> = {};
      for (const k of dirty.current) {
        (partial as unknown as Record<string, unknown>)[k] = current[k];
      }
      dirty.current = new Set();
      setSaving(true);
      window.epo
        .updateSettings(partial)
        .then((saved) => onSavedRef.current(saved))
        .catch(() => {
          /* foundation logs; the draft keeps the user's values */
        })
        .finally(() => setSaving(false));
    }, AUTOSAVE_MS);
  }, []);

  const patch = useCallback(
    (part: Partial<Settings>) => {
      setDraft((prev) => {
        if (!prev) return prev;
        for (const k of Object.keys(part) as Array<keyof Settings>) dirty.current.add(k);
        const next = { ...prev, ...part };
        scheduleSave();
        return next;
      });
    },
    [scheduleSave],
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

  const replace = useCallback((next: Settings) => {
    if (timer.current) window.clearTimeout(timer.current);
    dirty.current = new Set(); // pending edits are superseded — nothing to save
    setDraft(next);
    setPreset(detectPreset(next));
  }, []);

  return {
    draft,
    preset,
    saving,
    locked: preset !== 'custom',
    set,
    patch,
    setRate,
    setPreset: setPresetCb,
    replace,
  };
}
