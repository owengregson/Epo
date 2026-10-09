/**
 * SHADOW PARSE — the step that earns the right to switch.
 *
 * Every endpoint is `mode: 'observe'` in this wave: the LEGACY extractor still
 * drives behaviour, and the schema runs beside it purely to be compared. A
 * disagreement logs the zod issue path (or the differing fact) and ticks
 * `SurfaceHealth.disagreed`; nothing about the app's behaviour changes.
 *
 * That ordering is not caution for its own sake — it is risk #1 of the design:
 * a body today's lenient extractor tolerates, rejected by a stricter schema,
 * would kill a whole census mid-walk. The per-endpoint `observe | enforce` mode
 * is what lets a single endpoint be flipped, and rolled back, without a release.
 */

import { surface } from '@/surface/index';
import { readResponse, SURFACE_HEALTH } from '@/surface/parse';
import type { EndpointKind } from '@/surface/schema/endpoints';
import type { ProjectCtx, Projection } from '@/surface/schema/surface';
import * as logger from '@/utils/logger';

/** What the caller says the LEGACY extractor produced, for the comparison. */
/**
 * Describe the disagreement between the legacy result and the projection, or
 * `null` when they agree. The caller owns this because only it knows the legacy
 * shape; keeping it out of `src/surface` is what lets the surface package stay
 * free of adapter types.
 */
export type ShadowCompare = (projection: Projection) => string | null;

export interface ShadowInput {
  kind: EndpointKind;
  /** The already-JSON-parsed body (never a string). */
  body: unknown;
  ctx: ProjectCtx;
  /** True when the legacy extractor itself reported a shape mismatch. */
  legacyMismatch: boolean;
  compare?: ShadowCompare;
}

/**
 * Run the schema alongside the legacy extractor. Returns the projection when
 * the schema parsed (so an `enforce` flip has something to consume) and `null`
 * otherwise. NEVER throws: a shadow parse that can break the live path is worse
 * than no shadow parse.
 */
export function shadowParse(input: ShadowInput): Projection | null {
  const endpoint = surface().endpoints.find((e) => e.kind === input.kind);
  if (endpoint === undefined) return null;

  let result: ReturnType<typeof readResponse>;
  try {
    result = readResponse(endpoint, input.body, input.ctx);
  } catch (e) {
    // A projector throwing is itself drift evidence, and must not escape into
    // the live read path.
    SURFACE_HEALTH.mismatch(input.kind, input.ctx.at);
    logger.warn('surface.shadow: projector threw', { endpoint: input.kind, error: String(e) });
    return null;
  }

  if (!result.ok) {
    SURFACE_HEALTH.mismatch(input.kind, input.ctx.at);
    // A body the LEGACY extractor also rejected is not news — both agree it is
    // drift. Only a disagreement is worth a warn.
    if (!input.legacyMismatch) {
      logger.warn('surface.shadow: schema rejected a body the extractor accepted', {
        endpoint: input.kind,
        issues: result.issues.slice(0, 4).map((i) => `${i.path} — ${i.message}`),
      });
      SURFACE_HEALTH.disagreed(input.kind);
    }
    return null;
  }

  SURFACE_HEALTH.parsed(input.kind, {
    novelKeys: result.novelKeys,
    rowIssues: result.projection.rowIssues.length,
  });

  if (result.novelKeys.length > 0) {
    logger.debug('surface.shadow: unknown keys observed', {
      endpoint: input.kind,
      keys: result.novelKeys.slice(0, 8),
    });
  }
  if (result.projection.rowIssues.length > 0) {
    logger.warn('surface.shadow: rows rejected inside a valid body', {
      endpoint: input.kind,
      count: result.projection.rowIssues.length,
      first: result.projection.rowIssues[0],
    });
    SURFACE_HEALTH.disagreed(input.kind);
  }

  if (input.legacyMismatch) {
    logger.warn('surface.shadow: extractor rejected a body the schema accepted', {
      endpoint: input.kind,
    });
    SURFACE_HEALTH.disagreed(input.kind);
    return result.projection;
  }

  const disagreement = input.compare?.(result.projection) ?? null;
  if (disagreement !== null) {
    logger.warn('surface.shadow: schema and extractor disagree', {
      endpoint: input.kind,
      detail: disagreement,
    });
    SURFACE_HEALTH.disagreed(input.kind);
  }
  return result.projection;
}
