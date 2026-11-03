import * as fs from 'node:fs';
import { warn } from '../../utils/logger';
import {
  type PatternSettings,
  PERSONAS,
  type PersonaId,
  type ResolvedPattern,
  resolvePattern,
} from '../pattern-map';
import {
  AT_LEAST,
  AT_MOST,
  type NumericKnob,
  PERSONA_IDS,
  RULES,
  type Rule,
  sanitizePattern,
} from './settings-v1-rules';
import type { Settings } from './settings-v1-types';

/**
 * Every knob name, projected from {@link RULES} — the ONE list of what a
 * settings object may contain. The IPC boundary guard (`src/ipc/guards.ts`)
 * builds its `updateSettings` shape check from this, so a new knob is admitted
 * over IPC by the same edit that declares it (ADR 1009). Values stay
 * unvalidated there on purpose: clamping is {@link sanitizeSettings}'s job,
 * and coercion is not validation (ADR 0103).
 */
export const SETTINGS_KEYS: readonly (keyof Settings)[] = Object.keys(RULES) as (keyof Settings)[];

/**
 * Fallback values for every knob, projected from {@link RULES} so the default
 * and the clamp can never describe different values. Time knobs are in display
 * units; the 14 pacing knobs come from the `balanced` persona's bundle.
 */
export const DEFAULT_SETTINGS: Settings = Object.fromEntries(
  Object.entries(RULES).map(([key, rule]) => [key, (rule as Rule<unknown>).fallback]),
) as unknown as Settings;

/**
 * Clamp every knob into its sane range. The UI keeps its own input guards, but
 * settings also arrive from disk and over IPC unvalidated — a hand-edited file
 * (or a bad renderer payload) must never produce a negative delay, a 100%
 * jitter that fires actions back-to-back, an inverted band, or a whitelist that
 * isn't an array (which used to crash the prune scan). Every out-of-range value
 * degrades to the nearest safe one, never to a throw.
 */
export function sanitizeSettings(s: Settings): Settings {
  const raw = s as unknown as Record<string, unknown>;
  const out = Object.fromEntries(
    Object.entries(RULES).map(([key, rule]) => [key, (rule as Rule<unknown>).coerce(raw[key])]),
  ) as unknown as Settings;

  const nums = out as unknown as Record<NumericKnob, number>;
  for (const [a, b] of AT_LEAST) nums[a] = Math.max(nums[a], nums[b]);
  for (const [a, b] of AT_MOST) nums[a] = Math.min(nums[a], nums[b]);

  // Qualitative pattern: a NAMED persona is authoritative — the numeric pacing
  // knobs are DERIVED from its bundle (users tune behavior, not distributions).
  // In 'custom' mode the numeric knobs are kept as clamped UNLESS a `pattern`
  // object exists, in which case the UI tuned it and its numbers derive too. A
  // legacy numbers-only file has no `pattern`, so its hand-set knobs survive
  // migration. The default persona 'balanced' derives exactly the historical
  // numeric defaults, so a fresh install is unchanged.
  const named =
    typeof s.persona === 'string' &&
    PERSONA_IDS.includes(s.persona) &&
    s.persona !== 'custom'
      ? (s.persona as Exclude<PersonaId, 'custom'>)
      : null;
  if (named !== null) {
    out.persona = named;
    out.pattern = { ...PERSONAS[named] };
    applyResolvedPattern(out, resolvePattern(out.pattern));
  } else {
    out.persona = 'custom';
    out.pattern = sanitizePattern(s.pattern);
    if (s.pattern !== undefined && s.pattern !== null) {
      applyResolvedPattern(out, resolvePattern(out.pattern));
    }
  }

  return out;
}

/**
 * Write the 14 persona-derived knobs into `out`. `ResolvedPattern`'s keys ARE
 * those knobs, so adding one to the bundle lands here with no edit.
 */
function applyResolvedPattern(out: Settings, rp: ResolvedPattern): void {
  Object.assign(out, rp);
}

/**
 * Load settings from `filePath`, merged over {@link DEFAULT_SETTINGS} so a partial or
 * older file still yields a complete object. A missing file or a parse error is NOT an
 * error condition: it returns the defaults and logs a warning (never throws).
 */
export function loadSettings(filePath: string): Settings {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    warn('settings: no settings file, using defaults', { filePath, error: String(err) });
    return { ...DEFAULT_SETTINGS };
  }

  try {
    return sanitizeSettings(migrateLegacyPattern(JSON.parse(raw) as Partial<Settings>));
  } catch (err) {
    warn('settings: failed to parse settings file, using defaults', {
      filePath,
      error: String(err),
    });
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * A file predating the qualitative pattern model has no `persona`/`pattern`.
 * Treat it as 'custom' AND drop the default-merged pattern, so its hand-set
 * numeric knobs survive instead of being re-derived from a nominal pattern.
 * Runs BEFORE the sanitizer, which is where the derivation happens.
 */
function migrateLegacyPattern(parsed: Partial<Settings>): Settings {
  const legacyNoPattern = !('pattern' in parsed);
  if (!('persona' in parsed)) parsed.persona = 'custom';
  const merged = { ...DEFAULT_SETTINGS, ...parsed };
  if (legacyNoPattern && merged.persona === 'custom') {
    (merged as { pattern?: PatternSettings }).pattern = undefined;
  }
  return merged;
}

/**
 * Persist settings to `filePath` atomically: write a temp sibling then rename over the
 * target, so a crash mid-write can never leave a truncated/corrupt settings file.
 */
export function saveSettings(filePath: string, s: Settings): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
