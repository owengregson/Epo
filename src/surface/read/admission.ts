/**
 * Read admission (spec §10.2): which sinks a read's tier and completeness may feed. A destructive
 * claim needs a canonical or normalized, complete read; a recovered read only ever adds facts.
 */

import type { Tier } from '@/surface/schema/projection';

/** What a consumer does with a read: destroys a fact, drops a candidate, or only adds. */
export type SinkClass = 'destructive' | 'guarded' | 'additive';

/** Whether a read with this tier and completeness may feed a sink of this class. */
export function admits(sink: SinkClass, m: { readonly tier: Tier; readonly partial: boolean }): boolean {
  switch (sink) {
    case 'destructive':
      return m.tier !== 'recovered' && !m.partial;
    case 'guarded':
      return m.tier !== 'recovered';
    case 'additive':
      return true;
  }
}
