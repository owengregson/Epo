/**
 * One decoder for every body (spec §10.5): a declared JSON guard at offset 0, newline-delimited or
 * multipart payloads merged by path, errors concatenated, and the final flag. Never throws; the
 * framing keys are declared per surface version, so nothing here is an Instagram literal.
 */

import { SURFACE_BOUNDS } from '@/kernel/surface-policy';

/** A surface version's transport keys (`versions/<capture>/transport-decl.ts`). */
export interface TransportDecl {
  readonly jsonGuards: readonly string[];
  /** Dotted path of the streaming final flag; `false` on the last payload makes the body partial. */
  readonly finalFlagPath: string | null;
  /** Incremental payload keys: `{path, data}` merges, `{path, items}` appends, `list` wraps parts. */
  readonly incremental: { readonly path: string; readonly data: string; readonly items: string; readonly list: string;
    readonly errors: string };
  /** The form field naming a GraphQL operation (read only with the optional request-field capture). */
  readonly formOpKey: string;
  readonly rootFieldHeader: string;
  readonly friendlyNameHeader: string;
  /** Media types whose 2xx body is data (anything else on an API URL is a wall or not data). */
  readonly parseableMime: RegExp;
}

export type Decoded =
  | { readonly ok: true; readonly json: unknown; readonly format: 'json' | 'guarded' | 'ndjson' | 'multipart';
      readonly payloads: number; readonly final: boolean | null }
  | { readonly ok: false; readonly reason: 'empty' | 'invalid-json' | 'bad-frame'; readonly head: string };

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Path segments a payload may never walk through: a merge never reaches a prototype. */
const UNSAFE_KEY = /^(?:__proto__|constructor|prototype)$/;

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false }; // not one JSON document: the framings below decide
  }
}

/** An own, plain property write (never the `__proto__` setter). */
const put = (target: Json, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

/** Deep-merge `source` into `target`: records merge, anything else replaces. */
function mergeInto(target: Json, source: Json): void {
  for (const [key, value] of Object.entries(source)) {
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isRecord(current) && isRecord(value)) mergeInto(current, value);
    else put(target, key, value);
  }
}

/** The record or list at `path` under `base`, creating records on the way; `null` when unusable. */
function containerAt(base: Json, path: readonly unknown[]): Json | unknown[] | null {
  let at: Json | unknown[] = base;
  for (const seg of path) {
    if ((typeof seg !== 'string' && typeof seg !== 'number') || UNSAFE_KEY.test(String(seg))) return null;
    const key = String(seg);
    if (!Object.hasOwn(at, key)) {
      if (Array.isArray(at)) return null;
      put(at, key, {});
    }
    const next: unknown = (at as Json)[key];
    if (!isRecord(next) && !Array.isArray(next)) return null;
    at = next;
  }
  return at;
}

/** Apply one incremental part to the root's data; false when it is not a part this decoder knows. */
function applyPart(root: Json, part: unknown, decl: TransportDecl): boolean {
  const inc = decl.incremental;
  if (!isRecord(part) || !Array.isArray(part[inc.path])) return false;
  if (!isRecord(root[inc.data])) put(root, inc.data, {});
  const target = containerAt(root[inc.data] as Json, part[inc.path] as unknown[]);
  const data = part[inc.data];
  const items = part[inc.items];
  if (isRecord(target) && isRecord(data)) mergeInto(target, data);
  else if (Array.isArray(target) && Array.isArray(items)) target.push(...items);
  else return false;
  return true;
}

/** Merge payloads: the first is the root; each later one is a part, a list of parts, or metadata only. */
function merge(payloads: unknown[], decl: TransportDecl): Json | null {
  const [first, ...rest] = payloads;
  if (!isRecord(first)) return null;
  const inc = decl.incremental;
  const finalKey = decl.finalFlagPath?.split('.')[0];
  const errors: unknown[] = Array.isArray(first[inc.errors]) ? [...(first[inc.errors] as unknown[])] : [];
  for (const p of rest) {
    if (!isRecord(p)) return null;
    if (Array.isArray(p[inc.errors])) errors.push(...(p[inc.errors] as unknown[]));
    const parts = Array.isArray(p[inc.list]) ? (p[inc.list] as unknown[]) : inc.path in p ? [p] : [];
    if (!parts.every((part) => applyPart(first, part, decl))) return null;
    const metadataOnly = parts.length > 0 || Object.keys(p).every((k) => k === inc.errors || k === finalKey);
    if (!metadataOnly) return null;
  }
  if (errors.length > 0) put(first, inc.errors, errors);
  return first;
}

function finalOf(payload: unknown, decl: TransportDecl): boolean | null {
  if (decl.finalFlagPath === null) return null;
  let at: unknown = payload;
  for (const key of decl.finalFlagPath.split('.')) at = isRecord(at) ? at[key] : undefined;
  return typeof at === 'boolean' ? at : null;
}

/** Multipart parts (the body opens with `--<boundary>`), each headers, a blank line, then JSON. */
function multipartPayloads(text: string): unknown[] | 'bad' | null {
  const boundary = /^--([^\r\n]+)\r?\n/.exec(text)?.[1];
  if (boundary === undefined) return null;
  const parts = text.split(`--${boundary}`).slice(1).filter((p) => !/^--\s*$/.test(p) && p.trim() !== '');
  const out: unknown[] = [];
  for (const part of parts) {
    const blank = /\r?\n\r?\n/.exec(part);
    const json = blank === null ? { ok: false as const } : parseJson(part.slice(blank.index + blank[0].length).trim());
    if (!json.ok) return 'bad';
    out.push(json.value);
  }
  return out.length > 0 ? out : 'bad';
}

/** Newline-delimited payloads: every non-blank line an object, more than one of them. */
function ndjsonPayloads(text: string): unknown[] | 'bad' | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length <= 1 || !lines.every((l) => l.startsWith('{'))) return null;
  const out: unknown[] = [];
  for (const line of lines) {
    const json = parseJson(line);
    if (!json.ok) return 'bad';
    out.push(json.value);
  }
  return out;
}

/** Decode one response body. */
export function decodeBody(text: string, decl: TransportDecl): Decoded {
  const head = text.slice(0, SURFACE_BOUNDS.logHeadChars);
  if (text.trim() === '') return { ok: false, reason: 'empty', head: '' };
  const guard = decl.jsonGuards.find((g) => text.startsWith(g));
  const body = guard === undefined ? text : text.slice(guard.length);
  const whole = parseJson(body);
  if (whole.ok) {
    return { ok: true, json: whole.value, format: guard === undefined ? 'json' : 'guarded', payloads: 1, final: finalOf(whole.value, decl) };
  }
  const multipart = multipartPayloads(body);
  const framed = multipart ?? ndjsonPayloads(body);
  if (framed === null) return { ok: false, reason: 'invalid-json', head };
  const merged = framed === 'bad' ? null : merge(framed, decl);
  if (merged === null || framed === 'bad') return { ok: false, reason: 'bad-frame', head };
  return { ok: true, json: merged, format: multipart === null ? 'ndjson' : 'multipart', payloads: framed.length,
    final: finalOf(framed[framed.length - 1], decl) };
}
