/**
 * One observed gate (spec §10.5): what an observed response is before its body is read. A wall is
 * never drift; a 404 is its own kind; only a 2xx with a parseable media type is data.
 */

import { HTTP_STATUS as HTTP } from '@/kernel/surface-policy';

export type Gate =
  | { readonly kind: 'data' }
  | { readonly kind: 'wall'; readonly family: 'rate-limited' | 'auth'; readonly via: 'http' | 'html'; readonly status: number }
  | { readonly kind: 'http-absent' }
  | { readonly kind: 'not-data'; readonly status: number; readonly mime: string };

/** Gate one response by status, media type and (only after those) the body head. */
export function gateObserved(status: number, mime: string, parseableMime: RegExp, head?: string): Gate {
  if (status === HTTP.tooManyRequests || status >= HTTP.serverErrorMin) {
    return { kind: 'wall', family: 'rate-limited', via: 'http', status };
  }
  if (status === HTTP.unauthorized || status === HTTP.forbidden) return { kind: 'wall', family: 'auth', via: 'http', status };
  // An HTML page where an API body belongs is a wall, whatever its status.
  if (/text\/html/i.test(mime) || (head ?? '').trimStart().startsWith('<')) {
    return { kind: 'wall', family: 'rate-limited', via: 'html', status };
  }
  if (status === HTTP.notFound) return { kind: 'http-absent' };
  const success = status >= HTTP.okMin && status < HTTP.okEnd;
  return success && parseableMime.test(mime) ? { kind: 'data' } : { kind: 'not-data', status, mime };
}
