/**
 * Boundary guards for the Settings v2 rows (Appendix B.9, ADR 1009): shape only,
 * never value policy — coercion clamps values, the settings service validates
 * handles. Spread into `GUARDS`; imported by `guards.ts` only (zod stays main-side).
 */

import { z } from 'zod';
import {
  ACTIVITY_LEVELS, AUDIENCE_FOCUSES, AUDIENCE_SIZES, CAUTIONS, CLEANUP_LEVELS, CONSISTENCIES, DAY_SHAPES,
  MAX_DAYS_OFF, MUTUAL_POLICIES, PATIENCES, RHYTHMS, WEEKLY_SHAPES,
} from '@/shared/settings-intent';
import type { SettingsOp } from '@/shared/settings-ops';
import { T2_PARAM_KEYS, TEMPO_PARAM_KEYS } from '@/shared/settings-params';

const MINUTE = z.number().int().min(0).max(1439);
const QUIET_HOURS = z.union([
  z.object({ kind: z.literal('derived') }),
  z.object({ kind: z.literal('custom'), startMinute: MINUTE, endMinute: MINUTE }),
  z.object({ kind: z.literal('none') }),
]);
const intentOp = <K extends string>(key: K, value: z.ZodType) => z.object({ op: z.literal('intent'), key: z.literal(key), value });
const INTENT_OP = z.union([
  intentOp('activity', z.enum(ACTIVITY_LEVELS)), intentOp('caution', z.enum(CAUTIONS)),
  intentOp('rhythm', z.enum(RHYTHMS)), intentOp('consistency', z.enum(CONSISTENCIES)),
  intentOp('dayShape', z.enum(DAY_SHAPES)), intentOp('weeklyShape', z.enum(WEEKLY_SHAPES)),
  intentOp('quietHours', QUIET_HOURS),
  intentOp('daysOff', z.array(z.number().int().min(0).max(6)).max(MAX_DAYS_OFF)),
  intentOp('patience', z.enum(PATIENCES)), intentOp('mutuals', z.enum(MUTUAL_POLICIES)),
  intentOp('cleanup', z.enum(CLEANUP_LEVELS)), intentOp('audienceFocus', z.enum(AUDIENCE_FOCUSES)),
  intentOp('audienceSize', z.enum(AUDIENCE_SIZES)), intentOp('preferPrivate', z.boolean()),
]);

const FINITE = z.number().finite();
const CURVE = z.object({ hardLow: FINITE, bandLow: FINITE, peakLow: FINITE, peakHigh: FINITE, bandHigh: FINITE, hardHigh: FINITE });
const PARAM_VALUE = z.union([FINITE, z.boolean(), z.object({ min: FINITE, max: FINITE }), CURVE]);
const PARAM_KEY = z.enum([...T2_PARAM_KEYS, ...TEMPO_PARAM_KEYS]);
const USERNAME = z.string().max(64);
const PK = z.string().regex(/^\d{1,25}$/);
const WORD = z.string().max(100);
const SOURCE = z.enum(['you', 'migrated', 'older-version', 'prune-page']);
const ACCOUNT = z.object({
  pk: PK.nullable(), username: USERNAME, linkedAt: FINITE.nullable(), formerUsernames: z.array(USERNAME),
  addedAt: FINITE, source: SOURCE, valid: z.boolean(),
});
const SECTION = z.enum(['pace', 'schedule', 'audience', 'unfollow', 'protection', 'boost', 'app', 'timing', 'explore',
  'limits', 'technical', 'diagnostics']);

const OP = z.union([
  INTENT_OP,
  z.object({ op: z.literal('override'), key: PARAM_KEY, value: PARAM_VALUE }),
  z.object({ op: z.literal('clear-override'), key: PARAM_KEY }),
  z.object({ op: z.literal('seed'), handle: z.string().max(64) }),
  z.object({ op: z.literal('protect-add'), entries: z.array(z.object({ username: USERNAME, pk: PK.optional() })).max(5000),
    source: SOURCE }),
  z.object({ op: z.literal('protect-remove'), match: z.object({ pk: PK.optional(), username: USERNAME.optional() }) }),
  z.object({ op: z.literal('protect-restore'), accounts: z.array(ACCOUNT), words: z.array(z.object({ text: WORD, addedAt: FINITE })) }),
  z.object({ op: z.literal('word-add'), texts: z.array(WORD).max(50) }),
  z.object({ op: z.literal('word-remove'), text: WORD }),
  z.object({ op: z.literal('protect-rule'), rule: z.literal('keepVerified'), value: z.boolean() }),
  z.object({ op: z.literal('protect-rule'), rule: z.literal('wordMatch'), value: z.enum(['anywhere', 'whole-word']) }),
  z.object({ op: z.literal('protect-link'), pk: PK, username: USERNAME, at: FINITE }),
  z.object({ op: z.literal('pref'), key: z.enum(['practice', 'acceptRequests', 'boost.acceptRequests']), value: z.boolean() }),
  z.object({ op: z.literal('pref'), key: z.literal('boost.hours'), value: FINITE }),
  z.object({ op: z.literal('ui'), mode: z.enum(['easy', 'advanced']) }),
  z.object({ op: z.literal('tour-completed'), at: FINITE }),
  z.object({ op: z.literal('tour-version-seen'), version: z.string().max(64) }),
  z.object({ op: z.literal('dismiss-notice'), id: z.string().max(100) }),
  z.object({ op: z.literal('acknowledge-protection') }),
  z.object({ op: z.literal('import-older-version') }),
  z.object({ op: z.literal('migration'), action: z.enum(['retry', 'start-from-recommended', 'remigrate-from-v1']) }),
  z.object({ op: z.literal('consume-bookkeeping') }),
  z.object({ op: z.literal('reset'), scope: z.union([
    z.object({ kind: z.literal('recommended') }), z.object({ kind: z.literal('section'), section: SECTION }),
  ]) }),
]);

/** One call's ops: 1–64, each a known op of the right shape. */
const SETTINGS_OPS = z.array(OP).min(1).max(64) as unknown as z.ZodType<readonly SettingsOp[], unknown>;
/** A typeahead query: a handle prefix (an optional '@' plus 30). */
const QUERY = z.string().max(31);
const SCOPE = z.enum(['following', 'known']);
const PAGE = z.number().int().min(0).max(10_000);

/** Checked against each row's argument tuple where `GUARDS` spreads them. */
export const SETTINGS_GUARDS = {
  applySettings: [SETTINGS_OPS] as const,
  previewSettings: [SETTINGS_OPS] as const,
  suggestAccounts: [QUERY, SCOPE] as const,
  keptList: [PAGE] as const,
};
