/**
 * Coercion for the v2 document (ADR 0103 style): every field is repaired to the
 * nearest safe value, never a throw; garbage is dropped and COUNTED so the caller
 * can put protection under review. Shape only — value bounds apply at resolve time.
 * The table is `satisfies`-linked to the document, so a field cannot go uncoerced.
 */
import {
  ACTIVITY_LEVELS, AUDIENCE_FOCUSES, AUDIENCE_SIZES, CAUTIONS, CLEANUP_LEVELS, CONSISTENCIES, DAY_SHAPES,
  type DayOfWeek, type Intent, MAX_DAYS_OFF, MUTUAL_POLICIES, PATIENCES, type QuietHours, RHYTHMS, WEEKLY_SHAPES,
} from '@/shared/settings-intent';
import type { KeepWord, ParamValue, ProtectedAccount, ProtectionSettings } from '@/shared/settings-model';
import { T2_PARAM_KEYS, TEMPO_PARAM_KEYS } from '@/shared/settings-params';
import { DEFAULT_DOC, type OverrideEntry, RECOMMENDED_INTENT, type SettingsDocV2 } from './doc';

/** A repaired value and how many pieces of the input were dropped to get it. */
export interface Coerced<T> { readonly value: T; readonly dropped: number }
type Rule<T> = (raw: unknown, fallback: T) => Coerced<T>;

const ok = <T>(value: T, dropped = 0): Coerced<T> => ({ value, dropped });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const keep = <T>(test: (v: unknown) => v is T): Rule<T> => (raw, fb) => (test(raw) ? ok(raw) : ok(fb, raw === undefined ? 0 : 1));
const oneOf = <T extends string>(xs: readonly T[]): Rule<T> => keep((v): v is T => typeof v === 'string' && xs.includes(v as T));
const bool = keep((v): v is boolean => typeof v === 'boolean');
const str = keep((v): v is string => typeof v === 'string');
const epochOrNull = keep((v): v is number | null => v === null || (isNum(v) && v > 0));
const strOrNull = keep((v): v is string | null => v === null || typeof v === 'string');

/** Keep the valid items of a list, counting the rest; a non-list keeps the fallback. */
const listOf = <T>(item: (v: unknown) => T | null): Rule<readonly T[]> => (raw, fb) => {
  if (!Array.isArray(raw)) return ok(fb, raw === undefined ? 0 : 1);
  const kept = raw.map(item).filter((v): v is T => v !== null);
  return ok(kept, raw.length - kept.length);
};

const GRID_MINUTES = 30;
const snap = (m: number): number => ((Math.round(m / GRID_MINUTES) * GRID_MINUTES) % 1440 + 1440) % 1440;
const quietHours: Rule<QuietHours> = (raw, fb) => {
  if (!isObj(raw)) return ok(fb, raw === undefined ? 0 : 1);
  if (raw.kind === 'derived' || raw.kind === 'none') return ok({ kind: raw.kind });
  if (raw.kind === 'custom' && isNum(raw.startMinute) && isNum(raw.endMinute)) {
    const startMinute = snap(raw.startMinute);
    const endMinute = snap(raw.endMinute);
    // An empty window after snapping has no nearest safe value.
    if (startMinute !== endMinute) return ok({ kind: 'custom', startMinute, endMinute });
  }
  return ok(fb, 1);
};
const daysOff: Rule<readonly DayOfWeek[]> = (raw, fb) => {
  const listed = listOf((v): DayOfWeek | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 6 ? (v as DayOfWeek) : null))(raw, fb);
  const unique = [...new Set(listed.value)].sort();
  const value = unique.length > MAX_DAYS_OFF ? fb : unique;
  return ok(value, listed.dropped + (listed.value.length - unique.length) + (value === fb && unique.length > 0 ? 1 : 0));
};

const INTENT_RULES = {
  activity: oneOf(ACTIVITY_LEVELS), caution: oneOf(CAUTIONS), rhythm: oneOf(RHYTHMS), consistency: oneOf(CONSISTENCIES),
  dayShape: oneOf(DAY_SHAPES), weeklyShape: oneOf(WEEKLY_SHAPES), quietHours, daysOff, patience: oneOf(PATIENCES),
  mutuals: oneOf(MUTUAL_POLICIES), cleanup: oneOf(CLEANUP_LEVELS), audienceFocus: oneOf(AUDIENCE_FOCUSES),
  audienceSize: oneOf(AUDIENCE_SIZES), preferPrivate: bool,
} satisfies { [K in keyof Intent]: Rule<Intent[K]> };

/** Coerce a record field by field against a rules table and a fallback record. */
function record<T extends object>(rules: { [K in keyof T]: Rule<T[K]> }, raw: unknown, fb: T): Coerced<T> {
  const src = isObj(raw) ? raw : {};
  let dropped = raw === undefined || isObj(raw) ? 0 : 1;
  const out = {} as T;
  for (const key of Object.keys(rules) as (keyof T)[]) {
    const c = rules[key](src[key as string], fb[key]);
    out[key] = c.value;
    dropped += c.dropped;
  }
  return ok(out, dropped);
}

const isParamValue = (v: unknown): v is ParamValue =>
  isNum(v) || typeof v === 'boolean' || (isObj(v) && (
    (Object.keys(v).length === 2 && isNum(v.min) && isNum(v.max)) ||
    ['hardLow', 'bandLow', 'peakLow', 'peakHigh', 'bandHigh', 'hardHigh'].every((k) => isNum(v[k]))));
const PARAM_KEYS = new Set<string>([...T2_PARAM_KEYS, ...TEMPO_PARAM_KEYS]);
const overrides: Rule<SettingsDocV2['overrides']> = (raw, fb) => {
  if (!isObj(raw)) return ok(fb, raw === undefined ? 0 : 1);
  const out: Record<string, OverrideEntry> = {};
  let dropped = 0;
  for (const [key, e] of Object.entries(raw)) {
    if (PARAM_KEYS.has(key) && isObj(e) && isParamValue(e.value) && isNum(e.setAt) && isParamValue(e.basis)) {
      out[key] = { value: e.value, setAt: e.setAt, basis: e.basis };
    } else dropped += 1;
  }
  return ok(out as SettingsDocV2['overrides'], dropped);
};

const SOURCES = ['you', 'migrated', 'older-version', 'prune-page'] as const;
const account = (v: unknown): ProtectedAccount | null =>
  isObj(v) && typeof v.username === 'string' && (v.pk === null || typeof v.pk === 'string')
    && (v.linkedAt === null || isNum(v.linkedAt)) && isNum(v.addedAt) && typeof v.valid === 'boolean'
    && SOURCES.includes(v.source as (typeof SOURCES)[number])
    ? { pk: v.pk as string | null, username: v.username, linkedAt: v.linkedAt as number | null,
        formerUsernames: Array.isArray(v.formerUsernames) ? v.formerUsernames.filter((x): x is string => typeof x === 'string') : [],
        addedAt: v.addedAt, source: v.source as ProtectedAccount['source'], valid: v.valid }
    : null;
const word = (v: unknown): KeepWord | null =>
  isObj(v) && typeof v.text === 'string' && isNum(v.addedAt) ? { text: v.text, addedAt: v.addedAt } : null;
const PROTECTION_RULES = {
  accounts: listOf(account), words: listOf(word), wordMatch: oneOf(['anywhere', 'whole-word'] as const), keepVerified: bool,
} satisfies { [K in keyof ProtectionSettings]: Rule<ProtectionSettings[K]> };

const nonNegInt = keep((v): v is number => Number.isInteger(v) && (v as number) >= 0);
const BOOST_HOURS = { min: 1, max: 24 };
const hours: Rule<number> = (raw, fb) =>
  isNum(raw) ? ok(Math.min(BOOST_HOURS.max, Math.max(BOOST_HOURS.min, raw))) : ok(fb, raw === undefined ? 0 : 1);
const structured = <T>(test: (v: unknown) => boolean): Rule<T | null> =>
  (raw, fb) => (raw === null || test(raw) ? ok(raw as T | null) : ok(fb, raw === undefined ? 0 : 1));

export const DOC_RULES = {
  v: (raw) => ok(2 as const, raw === 2 ? 0 : 1),
  rev: nonNegInt,
  intent: (raw, fb) => record(INTENT_RULES, raw, fb),
  seed: str,
  overrides,
  protection: (raw, fb) => record(PROTECTION_RULES, raw, fb),
  // Garbage here pauses unfollows rather than trusting an unknown review state.
  protectionState: (raw) => (raw === 'ready' || raw === 'needs-review' || raw === 'unavailable' ? ok(raw) : ok('needs-review', 1)),
  prefs: (raw, fb) => record({
    practice: bool, acceptRequests: bool,
    boost: (r, f) => record({ hours, acceptRequests: bool }, r, f),
  }, raw, fb),
  app: (raw, fb) => record({
    mode: oneOf(['easy', 'advanced'] as const), tourCompletedAt: epochOrNull, tourVersionSeen: strOrNull,
    dismissedNotices: listOf((v) => (typeof v === 'string' ? v : null)),
  }, raw, fb),
  migration: structured((v) => isObj(v) && isNum(v.at) && Array.isArray(v.notes)),
  legacyCarry: structured((v) => isObj(v) && (v.pacingModel === 'legacy' || v.pacingModel === 'organic')),
} satisfies { [K in keyof SettingsDocV2]: Rule<SettingsDocV2[K]> };

/** Repair a parsed document; never throws. `dropped` counts every piece of garbage removed. */
export function coerceDoc(raw: unknown): Coerced<SettingsDocV2> {
  const fb: SettingsDocV2 = { ...DEFAULT_DOC, intent: RECOMMENDED_INTENT };
  return record(DOC_RULES, raw, fb);
}
