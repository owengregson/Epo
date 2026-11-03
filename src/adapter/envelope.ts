/**
 * The in-page fetch envelope and its failure classification, pure over the
 * signature lists it is given (`ig-surface.ts` passes the active surface's).
 */

import type { BlockSignature, SentinelStatus } from '@/adapter/surface-types';

/**
 * The uniform result EVERY in-page fetch script resolves to. In page context
 * the script checks `r.ok` and the content type and never lets `r.json()`
 * reject on an HTML/error body:
 *
 *  - JSON 2xx              → `{ ok: true,  status, contentType, json }`
 *  - non-JSON / non-ok     → `{ ok: false, status, contentType, textHead }`
 *  - network error / throw → `{ ok: false, status: 0, contentType: '', textHead: String(err) }`
 */
export interface FetchEnvelope {
  ok: boolean;
  status: number;
  contentType: string;
  json?: unknown;
  /** First 256 chars of a non-JSON body (or the error string). */
  textHead?: string;
  /** The response's final URL (after redirects) — lets callers spot login/challenge walls. */
  finalUrl?: string;
}

/** Narrow an unknown `evaluate` result to a {@link FetchEnvelope}, else `null`. */
export function asFetchEnvelope(value: unknown): FetchEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.ok !== 'boolean') return null;
  if (typeof v.status !== 'number') return null;
  if (typeof v.contentType !== 'string') return null;
  return value as unknown as FetchEnvelope;
}

/** Whether a (failed) envelope looks like an HTML wall rather than an API body. */
export function envelopeLooksLikeHtml(env: FetchEnvelope): boolean {
  if (env.contentType.toLowerCase().includes('text/html')) return true;
  const head = env.textHead ?? '';
  return head.trimStart().startsWith('<');
}

/**
 * The failure family a read-side {@link FetchEnvelope} belongs to — the
 * classification the recovery ladder keys off. Version-agnostic: it reads the
 * envelope's NUMBERS here and delegates every pattern to the active `SURFACE`
 * (block signatures live only in `src/adapter/versions/*`).
 */
export type EnvelopeKind = 'ok' | 'rate-limited' | 'auth' | 'gone' | 'network' | 'drift-suspect';

/** A classified envelope: the failure family plus the matched wall's status. */
export interface EnvelopeClassification {
  kind: EnvelopeKind;
  /** The sentinel status of the wall signature `finalUrl` matched, when one did. */
  wall?: SentinelStatus;
}

/** The signature lists an envelope is classified against; an `IgSurface` satisfies it. */
export interface EnvelopeSignatures {
  readonly blockSignatures: readonly BlockSignature[];
  readonly mutationRefusalSignatures: readonly BlockSignature[];
}

/**
 * Classify a fetch envelope into its failure family:
 *
 *  - `ok`            — a 2xx JSON body; nothing to recover from.
 *  - `auth`          — `finalUrl` matched a logged-out/challenge wall: the SESSION
 *                      is the problem (terminal, exactly like the sentinel path).
 *  - `rate-limited`  — HTTP 429/5xx, an `action-blocked` wall signature (URL or
 *                      refusal BODY), or an HTML page where an API body belongs.
 *  - `network`       — status 0: the fetch never reached Instagram.
 *  - `gone`          — a JSON 404: the resource genuinely does not exist.
 *  - `drift-suspect` — none of the above: an unrecognized refusal shape.
 *
 * Ambiguity deliberately defaults TOWARD `rate-limited`: waiting out a wall is
 * cheap and reversible; declaring drift (or fabricating an empty fact) is not.
 */
export function classifyEnvelopeWith(
  env: FetchEnvelope,
  signatures: EnvelopeSignatures,
): EnvelopeClassification {
  if (env.ok) return { kind: 'ok' };
  // A wall names itself by its final URL or, on a JSON refusal, by its body.
  const wall =
    signatures.blockSignatures.find((sig) => sig.pattern.test(env.finalUrl ?? '')) ??
    signatures.mutationRefusalSignatures.find((sig) => sig.pattern.test(env.textHead ?? ''));
  if (wall !== undefined) {
    return {
      kind: wall.status === 'logged-out' || wall.status === 'challenge' ? 'auth' : 'rate-limited',
      wall: wall.status,
    };
  }
  if (env.status === 429 || env.status >= 500) return { kind: 'rate-limited' };
  if (env.status === 0) return { kind: 'network' };
  if (envelopeLooksLikeHtml(env)) return { kind: 'rate-limited' };
  if (env.status === 404) return { kind: 'gone' };
  return { kind: 'drift-suspect' };
}
