/**
 * The plan-backed TempoSource (ADR 0607, spec §5.11): every Instagram-facing wait and gesture follows
 * the open session's tempo (else the ambient day tempo); each key draws from its own launch-seeded
 * stream; a `tempo.<key>` override is a slower-only reference factor; every key is enabled.
 */

import type { SessionTempo } from '../kernel/plan/types';
import { type TempoKey, type TempoSource, tempoSource } from '../kernel/tempo';

/** What the source reads from the plan: the tempo in force and the live tempo overrides. */
export interface PlanTempoProvider {
  current(): SessionTempo;
  overrides(): Readonly<Partial<Record<TempoKey, number>>>;
}

export function planTempoSource(plan: PlanTempoProvider, launchSeed: number): TempoSource {
  return tempoSource({
    current: () => plan.current(),
    launchSeed,
    overrideFactor: (key) => plan.overrides()[key] ?? 1,
    enabled: () => true,
  });
}
