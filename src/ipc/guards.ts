/** Validate renderer payloads before main handlers run. Invalid arguments receive each channel's typed fallback. */
import { z } from 'zod';
import type { BridgeMethod, Req } from '@/ipc/contract';
import { LIVE_GUARDS } from '@/ipc/guards-live';
import { PLAN_GUARDS } from '@/ipc/guards-plan';
import { SETTINGS_GUARDS } from '@/ipc/guards-settings';
import { FOLLOW_STATES } from '@/store/types';

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

/**
 * THE TABLE. A channel with no entry is unguarded — which is correct for the
 * ~30 channels that take no arguments at all, and stated rather than assumed.
 */
export const GUARDS = {
  restartFromSeed: [SEED],
  checkSeed: [SEED],
  queueList: [FOLLOW_STATE],
  chainDetail: [PK],
  ...SETTINGS_GUARDS,
  ...PLAN_GUARDS,
  ...LIVE_GUARDS,
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
