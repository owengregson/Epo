/**
 * The branded relationship fact (spec §10.4): a relationship read with every key it depends on
 * present, from a canonical or normalized read. Minted only by `src/surface/read/relationship.ts`.
 */

declare const observed: unique symbol;

/** Whether WE follow (or have requested) `pk`, read with every key it depends on present. */
export type ObservedRelation = { readonly pk: string; readonly weFollow: boolean; readonly [observed]: true };
