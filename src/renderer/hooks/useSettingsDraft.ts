import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Settings } from '@/types';
import { ceilFor, planFor } from '../lib/settings-derive';
import { detectPreset, presetPatch, type Aggressiveness } from '../lib/strategy-presets';

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

  // Adopt async-loaded settings the first time they arrive.
  useEffect(() => {
    if (draft === null && initial !== null) {
      setDraft(initial);
      setPreset(detectPreset(initial));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const scheduleSave = useCallback((next: Settings) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setSaving(true);
      window.epo
        .updateSettings(next)
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
        const next = { ...prev, ...part };
        scheduleSave(next);
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
