/**
 * The SHAPE DIGEST — the authoring aid behind `surface-lab diff`.
 *
 * Auto-generating schemas from recorded bodies produces overfit types: an
 * optional field becomes required because every captured account happened to
 * have it, and one account's `full_name: ""` becomes a literal. So the schemas
 * stay HUMAN-OWNED and this reports what the corpus actually contains, as a
 * canonical `path → typeset (seen/total)` tree.
 *
 * `diff` then names three classes of disagreement, which is all a maintainer
 * needs to decide whether a schema edit is warranted:
 *
 *  - REQUIRED-BUT-RARE — the schema demands a field the corpus rarely carries;
 *  - NOVEL — the corpus carries a key the schema does not know (drift, weeks
 *    before it becomes a break);
 *  - TYPE — the observed types and the declared ones disagree.
 */

import { z } from 'zod';
import { NOVELTY_SHAPES, novelKeys, type ShapeNode, shapeOf } from '@/surface/lab/shape';
import type { EndpointKind } from '@/surface/schema/endpoints';

/** One observed path: which JSON types it took, and how often it was present. */
export interface DigestEntry {
  path: string;
  types: string[];
  seen: number;
  total: number;
}

export type Digest = Record<string, DigestEntry>;

const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

/** Fold one body into `digest`. Array elements share their parent's `[]` path. */
export function digestBody(body: unknown, digest: Digest = {}, prefix = '', depth = 0): Digest {
  if (depth > 6 || body === null || typeof body !== 'object') return digest;
  if (Array.isArray(body)) {
    for (const entry of body) digestBody(entry, digest, `${prefix}[]`, depth + 1);
    return digest;
  }
  const record = body as Record<string, unknown>;
  // Every container occurrence counts once toward `total`, so a field present in
  // 398 of 412 rows reads as exactly that.
  const containerKey = `${prefix}{}`;
  const container = digest[containerKey] ?? { path: containerKey, types: ['object'], seen: 0, total: 0 };
  container.seen += 1;
  container.total += 1;
  digest[containerKey] = container;

  for (const [key, value] of Object.entries(record)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const entry = digest[path] ?? { path, types: [], seen: 0, total: 0 };
    const type = typeOf(value);
    if (!entry.types.includes(type)) entry.types.push(type);
    entry.seen += 1;
    digest[path] = entry;
    digestBody(value, digest, path, depth + 1);
  }
  // `total` is resolved at the END, not while walking: a field first seen in
  // container #1 and absent from #2..#50 would otherwise keep `total: 1` and
  // read as universally present — the exact overfit this tool exists to avoid.
  return depth === 0 ? finalizeDigest(digest) : digest;
}

/** Resolve every entry's `total` from its CONTAINER's occurrence count. */
export function finalizeDigest(digest: Digest): Digest {
  for (const entry of Object.values(digest)) {
    if (entry.path.endsWith('{}')) continue;
    const cut = entry.path.lastIndexOf('.');
    const containerKey = cut === -1 ? '{}' : `${entry.path.slice(0, cut)}{}`;
    entry.total = digest[containerKey]?.seen ?? entry.seen;
  }
  return digest;
}

/** One reported disagreement between the corpus and the schema. */
export interface DiffFinding {
  endpoint: EndpointKind;
  kind: 'required-but-rare' | 'novel' | 'type';
  path: string;
  detail: string;
}

/** Walk a shape tree into `path → node` pairs, so the diff can index it. */
function flattenShape(node: ShapeNode, prefix = '', out = new Map<string, ShapeNode>()): Map<string, ShapeNode> {
  if (node.props) {
    for (const [key, child] of node.props) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      out.set(path, child);
      flattenShape(child, path, out);
    }
  }
  if (node.items) flattenShape(node.items, `${prefix}[]`, out);
  if (node.values) flattenShape(node.values, `${prefix}.*`, out);
  return out;
}

/** Compare one endpoint's digest against its schema. */
export function diffEndpoint(
  endpoint: EndpointKind,
  bodies: readonly unknown[],
  rareThreshold = 0.5,
): DiffFinding[] {
  const schema = NOVELTY_SHAPES[endpoint];
  const node = shapeOf(schema);
  const known = flattenShape(node);
  const digest: Digest = {};
  for (const body of bodies) digestBody(body, digest);
  finalizeDigest(digest);

  const findings: DiffFinding[] = [];

  // NOVEL — a key the schema does not know. Reuses the runtime novelty pass, so
  // the lab and the live counters can never disagree about what "novel" means.
  const novel = new Set<string>();
  for (const body of bodies) for (const key of novelKeys(body, node)) novel.add(key);
  for (const path of [...novel].sort()) {
    findings.push({ endpoint, kind: 'novel', path, detail: 'the schema does not declare this key' });
  }

  for (const [path, shape] of known) {
    const observed = digest[path];
    if (observed === undefined) continue;
    // REQUIRED-BUT-RARE: a required field the corpus mostly lacks means the
    // schema will start rejecting real bodies.
    if (observed.total > 0 && observed.seen / observed.total < rareThreshold) {
      findings.push({
        endpoint,
        kind: 'required-but-rare',
        path,
        detail: `present in ${observed.seen}/${observed.total} containers`,
      });
    }
    // TYPE: the observed types and the declared PII class disagree in a way
    // worth a human look (a pk arriving as an object, say).
    if (shape.pii === 'pk' && observed.types.some((t) => t !== 'string' && t !== 'number')) {
      findings.push({
        endpoint,
        kind: 'type',
        path,
        detail: `declared pk, observed ${observed.types.join('|')}`,
      });
    }
  }
  return findings;
}

/** A JSON-Schema rendering of an endpoint's response schema (for the report). */
export const schemaJson = (endpoint: EndpointKind): unknown =>
  z.toJSONSchema(NOVELTY_SHAPES[endpoint], { io: 'input', unrepresentable: 'any' });
