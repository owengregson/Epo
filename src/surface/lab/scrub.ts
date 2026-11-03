/**
 * The fixture SCRUBBER — an allow-list driven by the schema's `pii` metadata.
 *
 * A committed corpus with a missed field is permanent and public, so the rule
 * is inverted from the usual one: a value survives only if the schema KNOWS the
 * field it sits in. Concretely, for a body:
 *
 *  - a known field with a scrub class      → a STABLE pseudonym of that class
 *    (`user_a1`, `Name A1`, a synthetic pk in a reserved numeric range, a count
 *    rounded to its leading digits, a time shifted into the synthetic window);
 *  - a known field with no class           → passed through verbatim (booleans,
 *    machine enums — the facts the contract tests assert on);
 *  - a key the schema does NOT know        → kept (its presence is the shape),
 *    with its value replaced by its TYPE NAME, except small non-strings
 *    (booleans, small finite numbers) which carry no identity.
 *
 * Stability matters: the same real value always maps to the same pseudonym
 * within one run, so `pk`, `pk_id`, `id` and `strong_id__` still agree and a
 * cross-reference between two bodies survives scrubbing.
 */

import type { z } from 'zod';
import { SCRUB_POLICY } from '@/kernel/scrub-policy';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { SCRUBBED_URL_HOST, scrubDom } from '@/surface/lab/scrub-dom';
import { type ScrubClass, type ShapeNode, shapeOf } from '@/surface/lab/shape';

export { SCRUBBED_URL_HOST };

/**
 * Synthetic pks count up from here. The reserved range cannot collide with a
 * real Instagram pk in the corpus; the structural leak rules hold every long
 * digit run in a corpus to this range or the synthetic time window.
 */
export const SYNTHETIC_PK_BASE = SCRUB_POLICY.syntheticPkBase;
/** The earliest time a scrubber sees (epoch seconds) maps to this one. */
export const SYNTHETIC_TIME_BASE = SCRUB_POLICY.syntheticTimeBase;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const letter = (n: number): string => LETTERS.charAt(n % LETTERS.length);
const round = (n: number): number => Math.floor(n / LETTERS.length) + 1;

/** Pseudonym for the Nth distinct handle: `user_a1`, `user_b1`, … */
const handleName = (n: number): string => `user_${letter(n)}${round(n)}`;

/** Pseudonym for the Nth distinct full name: `Name A1`, `Name B1`, … */
const displayName = (n: number): string => `Name ${letter(n).toUpperCase()}${round(n)}`;

/** The JSON type name a scrubbed unknown value is replaced by. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A count at or above the floor keeps only its leading digits; a smaller count identifies nothing. */
export function scrubCount(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) < SURFACE_BOUNDS.scrubCountFloor) return value;
  return Number(value.toPrecision(SURFACE_BOUNDS.scrubCountDigits));
}

/** Every value a `time` field carries in `value`, found by the walk the scrub itself takes. */
export function timesIn(value: unknown, node: ShapeNode, depth = 0, out: number[] = []): number[] {
  if (node.pii === 'time') {
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object' || depth > SCRUB_POLICY.maxDepth) return out;
  if (Array.isArray(value)) {
    if (node.items) for (const v of value) timesIn(v, node.items, depth + 1, out);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const known = node.props?.get(key) ?? node.values;
    if (known !== undefined) timesIn(child, known, depth + 1, out);
  }
  return out;
}

export interface ScrubStats {
  handles: number;
  names: number;
  pks: number;
  urls: number;
  texts: number;
  unknownKeys: number;
}

export class Scrubber {
  private readonly handles = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly pks = new Map<string, string>();
  private unknownKeys = 0;
  private texts = 0;
  private urls = 0;
  /** The whole second the synthetic time base stands for; the first time seen when nothing seeded it. */
  private timeOrigin: number | null = null;
  private readonly shapes = new Map<z.ZodType, ShapeNode>();

  /** The pseudonym for a real handle (stable for the lifetime of the scrubber). */
  handle(real: string): string {
    const key = real.toLowerCase();
    let alias = this.handles.get(key);
    if (alias === undefined) {
      alias = handleName(this.handles.size);
      this.handles.set(key, alias);
    }
    return alias;
  }

  /** The pseudonym for a real display name. */
  name(real: string): string {
    let alias = this.names.get(real);
    if (alias === undefined) {
      alias = displayName(this.names.size);
      this.names.set(real, alias);
    }
    return alias;
  }

  /** The synthetic id for a real pk. */
  pk(real: string | number): string {
    const key = String(real);
    let alias = this.pks.get(key);
    if (alias === undefined) {
      if (this.pks.size >= SCRUB_POLICY.syntheticPkSpan) throw new Error('scrub: the synthetic id range is spent');
      alias = String(SYNTHETIC_PK_BASE + this.pks.size);
      this.pks.set(key, alias);
    }
    return alias;
  }

  /** Anchor the synthetic time window at the earliest time any of these bodies carries. */
  seedTimes(schema: z.ZodType, bodies: readonly unknown[]): void {
    for (const body of bodies) {
      for (const t of timesIn(body, this.shape(schema))) {
        const whole = Math.trunc(t);
        if (this.timeOrigin === null || whole < this.timeOrigin) this.timeOrigin = whole;
      }
    }
  }

  /** Every real handle this scrubber has seen (the DOM pass reuses the table). */
  knownHandles(): string[] {
    return [...this.handles.keys()];
  }

  stats(): ScrubStats {
    return {
      handles: this.handles.size,
      names: this.names.size,
      pks: this.pks.size,
      urls: this.urls,
      texts: this.texts,
      unknownKeys: this.unknownKeys,
    };
  }

  /** Shift epoch seconds into the synthetic window: the origin lands on the base, intervals and fractions kept. */
  private time(value: unknown): unknown {
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.unknown(value);
    const whole = Math.trunc(value);
    this.timeOrigin ??= whole;
    const shifted = SYNTHETIC_TIME_BASE + (whole - this.timeOrigin);
    const fraction = String(value).split('.')[1];
    return fraction === undefined ? shifted : Number(`${shifted}.${fraction}`);
  }

  /** Replace one classified value with its stable pseudonym. */
  private pii(kind: ScrubClass, value: unknown): unknown {
    // An explicit null carries no identity, and "absent" vs "null" is a fact the parser reads.
    if (value === null || value === undefined) return value;
    switch (kind) {
      case 'handle':
        return typeof value === 'string' ? this.handle(value) : value;
      case 'name':
        return typeof value === 'string' && value !== '' ? this.name(value) : value;
      case 'pk':
        // The synthetic id keeps the ORIGINAL JSON type: `pending/` sends pks as
        // numbers and the replay test must still exercise that union branch.
        return typeof value === 'number' ? Number(this.pk(value)) : this.pk(String(value));
      case 'url': {
        if (typeof value !== 'string') return value;
        this.urls += 1;
        return `${SCRUBBED_URL_HOST}/pic/${this.pk(value)}.jpg`;
      }
      case 'cursor': {
        // A numeric cursor is a row offset — no identity, and the end-probe
        // contract depends on its exact value. Anything else is opaque: keep
        // its LENGTH and non-numeric shape, discard its bytes.
        if (typeof value === 'number') return value;
        if (typeof value !== 'string') return value;
        if (/^\d{1,9}$/.test(value)) return value;
        return `cursor.${this.pk(`cursor:${value}`)}.len${value.length}`;
      }
      case 'text': {
        if (typeof value !== 'string') return value;
        this.texts += 1;
        // The activity feed's `text` is what the follow-event projector matches
        // on, so the MARKER survives while the sentence does not.
        if (/started following you/i.test(value)) return 'user started following you';
        return value === '' ? '' : `scrubbed text (${value.length} chars)`;
      }
      case 'count':
        return typeof value === 'number' ? scrubCount(value) : this.unknown(value);
      case 'time':
        return this.time(value);
    }
  }

  private shape(schema: z.ZodType): ShapeNode {
    let node = this.shapes.get(schema);
    if (node === undefined) {
      node = shapeOf(schema);
      this.shapes.set(schema, node);
    }
    return node;
  }

  /** Scrub one JSON body against its schema's shape. */
  body(schema: z.ZodType, value: unknown): unknown {
    return this.value(value, this.shape(schema), 0);
  }

  private value(value: unknown, node: ShapeNode, depth: number): unknown {
    if (node.pii !== undefined) return this.pii(node.pii, value);
    if (value === null || typeof value !== 'object') return value;
    if (depth > SCRUB_POLICY.maxDepth) return typeName(value);

    if (Array.isArray(value)) {
      if (!node.items) return value.map((v) => this.unknown(v));
      return value.map((v) => this.value(v, node.items as ShapeNode, depth + 1));
    }

    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      const known = node.props?.get(key);
      if (known !== undefined) {
        out[key] = this.value(child, known, depth + 1);
        continue;
      }
      if (node.values !== undefined) {
        // A record: the KEY may itself be identity (a pk-keyed status map).
        const outKey = node.keyPii === undefined ? key : String(this.pii(node.keyPii, key));
        out[outKey] = this.value(child, node.values, depth + 1);
        continue;
      }
      this.unknownKeys += 1;
      out[key] = this.unknown(child);
    }
    return out;
  }

  /**
   * A value the schema knows nothing about: booleans and small finite numbers
   * are kept (non-identifying, and they preserve the shape a novelty pass
   * would report); everything else becomes its type name.
   */
  private unknown(value: unknown): unknown {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < SCRUB_POLICY.keptNumberMax) return value;
    return typeName(value);
  }

  /** Scrub a DOM snapshot through this scrubber's pseudonym tables (`scrub-dom.ts`). */
  dom(html: string): string {
    return scrubDom(html, {
      handle: (real) => this.handle(real),
      pk: (real) => this.pk(real),
      handles: this.handles,
      names: this.names,
    });
  }
}
