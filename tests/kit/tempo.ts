/**
 * Tempo fakes for suites that thread a TempoSource (ADR 0607): a source fixed
 * at one pace, and a recorder that lists every key a consumer asked for.
 */
import { REFERENCE_TEMPO, type TempoKey, type TempoSource, tempoSource } from '@/kernel/tempo';
import { TEMPO_POLICY } from '@/kernel/tempo-policy';

/** A source fixed at `pace` (motion = pace^½, depth = 1/pace), every key enabled. */
export function fixedTempo(pace: number, launchSeed = 0): TempoSource {
  const tempo = { ...REFERENCE_TEMPO, pace, motion: pace ** TEMPO_POLICY.MOTION_ELASTICITY, depth: 1 / pace };
  return tempoSource({ current: () => tempo, launchSeed });
}

/** A source that records every key asked for (`base`, `draw`, `policy`), in order; every key enabled. */
export interface RecordingTempo extends TempoSource {
  readonly keys: TempoKey[];
}

/** Records over `inner` (default: the reference tempo with the added keys switched on). */
export function recordingTempo(inner: TempoSource = tempoSource({ current: () => REFERENCE_TEMPO })): RecordingTempo {
  const keys: TempoKey[] = [];
  const note = (key: TempoKey): TempoKey => {
    keys.push(key);
    return key;
  };
  return {
    keys,
    current: () => inner.current(),
    base: (key) => inner.base(note(key)),
    draw: (key, site) => inner.draw(note(key), site),
    policy: (key, site) => inner.policy(note(key), site),
    gesture: () => inner.gesture(),
    enabled: () => true,
  };
}
