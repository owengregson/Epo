/**
 * The fixture SCRUBBER — an allow-list driven by the schema's `pii` metadata.
 *
 * A committed corpus with a missed field is permanent and public, so the rule
 * is inverted from the usual one: a value survives only if the schema KNOWS the
 * field it sits in. Concretely, for a body:
 *
 *  - a known field with a `pii` class      → a STABLE pseudonym of that class
 *    (`user_a1`, `Name A1`, a synthetic pk in a reserved numeric range);
 *  - a known field with no `pii` class     → passed through verbatim (booleans,
 *    counts, machine enums — the facts the contract tests assert on);
 *  - a key the schema does NOT know        → kept (its presence is the shape),
 *    with its value replaced by its TYPE NAME, except small non-strings
 *    (booleans, finite numbers) which carry no identity and are kept as-is.
 *
 * Stability matters: the same real handle always maps to the same pseudonym
 * within one run, so cross-references between fixtures (a pk in `show_many`
 * and the same pk in a followers page) survive scrubbing and the replay test
 * still exercises real joins.
 *
 * DOM snapshots get the same treatment through a different door — they are
 * markup, not JSON — but the same pseudonym tables, so a handle scrubbed in a
 * body and in a header snapshot lands on the same `user_a1`.
 */

import type { z } from 'zod';
import { SCRUBBED_URL_HOST, scrubDom } from '@/surface/lab/scrub-dom';
import { type ShapeNode, shapeOf } from '@/surface/lab/shape';
import type { PiiKind } from '@/surface/schema/endpoints';

export { SCRUBBED_URL_HOST };

/**
 * Synthetic pks start here. A reserved 12-digit range starting with `7` cannot
 * collide with a real Instagram pk in the corpus, and `tests/surface/leak.test.ts`
 * asserts exactly that: every long digit run in the corpus is in this range.
 */
export const SYNTHETIC_PK_BASE = 700_000_000_000;

/** Pseudonym for the Nth distinct handle: `user_a1`, `user_b1`, … */
const handleName = (n: number): string =>
  `user_${String.fromCharCode(97 + (n % 26))}${Math.floor(n / 26) + 1}`;

/** Pseudonym for the Nth distinct full name: `Name A1`, `Name B1`, … */
const displayName = (n: number): string =>
  `Name ${String.fromCharCode(65 + (n % 26))}${Math.floor(n / 26) + 1}`;

/** The JSON type name a scrubbed unknown value is replaced by. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
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
      alias = String(SYNTHETIC_PK_BASE + this.pks.size);
      this.pks.set(key, alias);
    }
    return alias;
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

  /** Replace one PII value with its stable pseudonym. */
  private pii(kind: PiiKind, value: unknown): unknown {
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
        // Bounded and dotted on purpose: an opaque cursor's LENGTH is
        // recorded rather than reproduced, so the replacement can never itself
        // look like the 40-char token the leak test hunts for.
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
    if (depth > 8) return typeName(value);

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
   * A value the schema knows nothing about: booleans and finite numbers are
   * kept (small, non-identifying, and they preserve the shape a novelty pass
   * would report); everything else becomes its type name.
   */
  private unknown(value: unknown): unknown {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e7) return value;
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
