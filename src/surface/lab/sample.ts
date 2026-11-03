/**
 * A drift sample (spec §10.7, owner Q25): the decoded body, its arrays cut to the sampled rows, scrubbed by the
 * allow-list scrubber, held to the structural leak rules and capped in size. A sample that still breaks a rule
 * is dropped; only the signature's detail remains. Samples stay local and leave only through Copy report.
 */

import { SCRUB_POLICY } from '@/kernel/scrub-policy';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { Scrubber } from '@/surface/lab/scrub';
import { SCRUB_SHAPES } from '@/surface/lab/shape';
import { structuralLeaks } from '@/surface/lab/structural-leak';
import { ENDPOINT_KINDS, type EndpointKind } from '@/surface/schema/endpoints';

/** Every array cut to the sampled rows: rows share a shape, and a sample is evidence, not a copy. */
function cut(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > SCRUB_POLICY.maxDepth) return value;
  if (Array.isArray(value)) return value.slice(0, SURFACE_BOUNDS.sampleRows).map((v) => cut(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cut(v, depth + 1)]));
}

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The scrubbed, leak-checked, size-capped sample of a decoded body; null when nothing safe remains. */
export function scrubSample(endpoint: string, decoded: unknown): string | null {
  // A mutation or routing signal has no response shape to scrub against: it keeps its detail only.
  if (!(ENDPOINT_KINDS as readonly string[]).includes(endpoint)) return null;
  const shape = SCRUB_SHAPES[endpoint as EndpointKind];
  const body = cut(decoded);
  const scrubber = new Scrubber();
  scrubber.seedTimes(shape, [body]);
  let text = JSON.stringify(scrubber.body(shape, body)) ?? '';
  if (text === '' || structuralLeaks(text).length > 0) return null;
  if (bytes(text) <= SURFACE_BOUNDS.sampleMaxBytes) return text;
  // Over the cap: keep a head that ends on a value boundary (no token cut in half), marked as cut.
  const tail = ',"…":"cut"';
  const room = SURFACE_BOUNDS.sampleMaxBytes - bytes(tail);
  while (bytes(text) > room) text = text.slice(0, text.length - (bytes(text) - room));
  text = `${text.slice(0, Math.max(0, text.lastIndexOf(',')))}${tail}`;
  return structuralLeaks(text).length === 0 ? text : null;
}
