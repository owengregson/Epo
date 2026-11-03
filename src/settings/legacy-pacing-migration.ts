/**
 * The retired pacer, mapped once (spec §5.13 S2 item 8, owner Q9): its legacy model becomes even days
 * (consistency `clockwork`, shown as Even) in a trickle rhythm with a notice. One path serves a v1 file
 * migrated now and a document an earlier build wrote with `legacyCarry`; the pacer keys are dropped loudly.
 */
import * as logger from '@/utils/logger';
import type { MigrationRecord, SettingsDocV2 } from './doc';

/** The pacer's knobs as v1 and the pre-switch document named them; nothing reads them any more. */
export const RETIRED_PACER_KEYS = ['pacingModel', 'minDelayMinutes', 'maxDelayMinutes', 'jitterPercent'] as const;

export type LegacyPacingModel = 'legacy' | 'organic';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The model a document written before the cadence switch carries in its `legacyCarry` record (null: none). */
export function carriedPacingModel(raw: unknown): LegacyPacingModel | null {
  const carry = isRecord(raw) ? raw.legacyCarry : undefined;
  const model = isRecord(carry) ? carry.pacingModel : undefined;
  return model === 'legacy' || model === 'organic' ? model : null;
}

/** The document with the mapping applied once; null (nothing carried) returns it unchanged. */
export function retireLegacyPacing(doc: SettingsDocV2, model: LegacyPacingModel | null, now: number): SettingsDocV2 {
  if (model === null) return doc;
  logger.warn('settings: the retired pacer keys are dropped; the day plan paces every action', { keys: RETIRED_PACER_KEYS, model });
  const m: MigrationRecord = doc.migration ?? { at: now, fromV1: null, notes: [], bookkeeping: null };
  if (model === 'organic' || m.notes.some((n) => n.kind === 'legacy-pacing-retired')) return doc;
  return {
    ...doc,
    intent: { ...doc.intent, consistency: 'clockwork', rhythm: 'trickle' },
    migration: { ...m, notes: [...m.notes, { kind: 'legacy-pacing-retired' }] },
  };
}
