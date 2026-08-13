import type { Settings } from '@/types';

/** Aggressiveness presets drive daily activity, delay band, and jitter together. */
export type Aggressiveness = 'conservative' | 'balanced' | 'aggressive' | 'custom';

export interface Preset {
  /** Daily operating rate (activity). */
  rate: number;
  /** Delay band (minutes). */
  dLo: number;
  dHi: number;
  /** Timing jitter percent. */
  jit: number;
  /** One-line summary shown under the segmented control. */
  hint: string;
}

export const PRESETS: Record<Exclude<Aggressiveness, 'custom'>, Preset> = {
  conservative: { rate: 30, dLo: 5, dHi: 10, jit: 35, hint: '30 / day · 5–10 min delay · ±35% jitter' },
  balanced: { rate: 55, dLo: 3, dHi: 6, jit: 25, hint: '55 / day · 3–6 min delay · ±25% jitter' },
  aggressive: { rate: 90, dLo: 2, dHi: 4, jit: 15, hint: '90 / day · 2–4 min delay · ±15% jitter' },
};

export const CUSTOM_HINT = 'Manual — these knobs hold their tuned values.';

export const AGGRESSIVENESS_ORDER: readonly Aggressiveness[] = [
  'conservative',
  'balanced',
  'aggressive',
  'custom',
];

/** The subset of Settings a preset writes. */
export type PresetPatch = Pick<
  Settings,
  'dailyOperatingRate' | 'minDelayMinutes' | 'maxDelayMinutes' | 'jitterPercent'
>;

/** Which preset (if any) the current settings values correspond to. */
export function detectPreset(s: PresetPatch): Aggressiveness {
  for (const key of ['conservative', 'balanced', 'aggressive'] as const) {
    const p = PRESETS[key];
    if (
      s.dailyOperatingRate === p.rate &&
      s.minDelayMinutes === p.dLo &&
      s.maxDelayMinutes === p.dHi &&
      s.jitterPercent === p.jit
    ) {
      return key;
    }
  }
  return 'custom';
}

/** The Settings values for a concrete preset (rate + delay + jitter). */
export function presetPatch(key: Exclude<Aggressiveness, 'custom'>): PresetPatch {
  const p = PRESETS[key];
  return {
    dailyOperatingRate: p.rate,
    minDelayMinutes: p.dLo,
    maxDelayMinutes: p.dHi,
    jitterPercent: p.jit,
  };
}

/** The hint text for any selection. */
export function presetHint(key: Aggressiveness): string {
  return key === 'custom' ? CUSTOM_HINT : PRESETS[key].hint;
}
