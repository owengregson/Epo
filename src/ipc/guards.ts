/**
 * Boundary validation for the renderer→main invokes. See ADR 1009.
 *
 * The renderer is a sandboxed `WebContentsView` with `contextIsolation` on, so
 * this is defence in depth rather than a live threat — but four channels take
 * a scalar straight into the store or the settings file
 * (`restartFromSeed(seed)`, `queueList(state)`, `chainDetail(targetPk)`,
 * `updateSettings(partial)`), and main must not trust a payload just because
 * the type says so. TypeScript is erased at the boundary; what actually
 * arrives over IPC is `unknown`.
 *
 * Two rules the schemas obey:
 *
 * 1. **Shape only, never value policy.** These guards reject payloads whose
 *    SHAPE the handler cannot use. Every clamp stays where it belongs — the
 *    settings `RULES` table (ADR 0103), whose semantics are coercion, not
 *    validation: `jitterPercent: 100` must become `90`, never a rejection.
 *    So `updateSettings` checks "a plain object whose keys are settings keys"
 *    and hands the values to `sanitizeSettings` untouched.
 * 2. **Never throw across the boundary.** A refusal logs at error with the
 *    channel and the failing path, then answers the channel's OWN typed
 *    fallback — the same contract `safe()` already holds (ADR 0101). The
 *    renderer always receives the shape its contract promises.
 *
 * This file is imported by `register.ts` only, so zod stays a main-process
 * cost: `contract.ts` remains dependency-free for the renderer bundle.
 */

import { z } from 'zod';
import type { BridgeMethod, Req } from '@/ipc/contract';
import { SETTINGS_KEYS } from '@/settings/settings';
import { FOLLOW_STATES } from '@/store/types';
import type { Settings } from '@/types';

/** One schema per positional argument of a bridge method. */
export type ArgSchemas<A extends readonly unknown[]> = {
  readonly [I in keyof A]: z.ZodType<A[I], unknown>;
};

/**
 * A seed handle as the renderer's Seed field can produce it: an optional `@`,
 * then Instagram's handle alphabet. Length matches the platform's 30-character
 * limit — anything longer is not a handle, it is a payload.
 */
const SEED = z
  .string()
  .trim()
  .min(1)
  .max(31)
  .regex(/^@?[A-Za-z0-9._]{1,30}$/, 'not an Instagram handle');

/** An account pk: Instagram ids are digit strings (`src/kernel/brand.ts`). */
const PK = z.string().regex(/^\d{1,25}$/, 'not an account pk');

/** A follow-record lifecycle state — the store's own iterable twin. */
const FOLLOW_STATE = z.enum(FOLLOW_STATES);

const SETTINGS_KEY_SET = new Set<string>(SETTINGS_KEYS);

/**
 * A settings patch: a plain object (not an array, not `null`, no prototype
 * games) whose every key is a declared knob. Values are deliberately
 * unchecked — `sanitizeSettings` clamps each one through the same `RULES`
 * table a hand-edited file goes through, and duplicating those ranges here
 * would be the second declaration ADR 0103 exists to prevent.
 */
const SETTINGS_PATCH = z.custom<Partial<Settings>>(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.keys(value).every((key) => SETTINGS_KEY_SET.has(key));
  },
  { message: 'not a settings patch (plain object of declared knobs)' },
);

/**
 * THE TABLE. A channel with no entry is unguarded — which is correct for the
 * ~30 channels that take no arguments at all, and stated rather than assumed.
 */
export const GUARDS = {
  restartFromSeed: [SEED],
  queueList: [FOLLOW_STATE],
  chainDetail: [PK],
  // Last, deliberately: the widest payload, and the one whose over-strictness
  // would silently cost a user a saved setting (see ADR 1009's risk note).
  updateSettings: [SETTINGS_PATCH],
} satisfies Partial<{ [M in BridgeMethod]: ArgSchemas<Req<M>> }>;

/** A channel that carries a boundary guard. */
export type GuardedMethod = keyof typeof GUARDS;

/** Why one argument was refused: which position, and zod's own path + message. */
export interface GuardFailure {
  /** Zero-based argument index. */
  readonly arg: number;
  /** Dotted path inside that argument (`''` for the argument itself). */
  readonly path: string;
  readonly message: string;
}

/**
 * Validate one call's arguments. `null` means "accepted"; a failure carries
 * enough to log WHERE it broke without dumping the payload.
 *
 * Arity is not checked: the contract's optional arguments (`growthSeries(days?)`)
 * legitimately arrive short, and a missing guarded argument is caught by its
 * own schema rejecting `undefined`.
 */
export function checkArgs(method: BridgeMethod, args: readonly unknown[]): GuardFailure | null {
  const schemas = (GUARDS as Partial<Record<BridgeMethod, readonly z.ZodType[]>>)[method];
  if (schemas === undefined) return null;
  for (const [index, schema] of schemas.entries()) {
    const result = schema.safeParse(args[index]);
    if (result.success) continue;
    const issue = result.error.issues[0];
    return {
      arg: index,
      path: issue?.path.join('.') ?? '',
      message: issue?.message ?? 'invalid',
    };
  }
  return null;
}
