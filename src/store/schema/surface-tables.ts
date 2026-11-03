import { col, table } from './tables';

/** Lifecycle of one drift signature. */
export type DriftState = 'open' | 'consistent' | 'contradicted' | 'resolved';

/**
 * One drift signature per surface × endpoint × class × path pattern. `detail`
 * holds types, op names and counts (JSON), never values; `sample` is a scrubbed
 * body kept on first sighting; `witness_keys` is a JSON array of subjects.
 */
export const SURFACE_DRIFT = table('surface_drift', {
  signature: col.text().key(),
  surface_id: col.text(),
  endpoint: col.text(),
  cls: col.text(),
  path: col.text(),
  detail: col.text(),
  first_seen_at: col.int(),
  last_seen_at: col.int(),
  seen: col.int().def('1'),
  sample: col.optText(),
  hint_pattern: col.optText(),
  witnesses: col.int().def('0'),
  contradictions: col.int().def('0'),
  witness_keys: col.text().def(`'[]'`),
  state: col.text<DriftState>().def(`'open'`),
  clean_reads: col.int().def('0'),
});

/** Per plan-day × surface × endpoint read counters. */
export const SURFACE_HEALTH = table('surface_health', {
  day: col.text().key(1),
  surface_id: col.text().key(2),
  endpoint: col.text().key(3),
  canonical: col.int().def('0'),
  normalized: col.int().def('0'),
  recovered: col.int().def('0'),
  failed: col.int().def('0'),
  walls: col.int().def('0'),
  row_issues: col.int().def('0'),
  field_issues: col.int().def('0'),
  shadow_disagreed: col.int().def('0'),
  last_read_at: col.optInt(),
  last_ok_at: col.optInt(),
  last_fail_at: col.optInt(),
});
