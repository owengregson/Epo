/**
 * The retired pacer's one-time mapping (spec §5.13 S2 item 8, owner Q9): legacy → Even + trickle with the
 * notice, organic → nothing, applied once, and the pacer keys always dropped loudly.
 */
import { DEFAULT_DOC } from '@/settings/doc';
import { carriedPacingModel, RETIRED_PACER_KEYS, retireLegacyPacing } from '@/settings/legacy-pacing-migration';
import { setLevel, setSink } from '@/utils/logger';

const NOW = 5_000;

function logged(fn: () => void): string[] {
  const lines: string[] = [];
  setLevel('warn');
  setSink((level, message) => lines.push(`${level} ${message}`));
  try {
    fn();
  } finally {
    setSink(null);
    setLevel('error');
  }
  return lines;
}

test('a carried record names its model; anything else carries none', () => {
  expect(carriedPacingModel({ legacyCarry: { pacingModel: 'legacy', minDelayMinutes: 4 } })).toBe('legacy');
  expect(carriedPacingModel({ legacyCarry: { pacingModel: 'organic' } })).toBe('organic');
  for (const raw of [{}, { legacyCarry: null }, { legacyCarry: { pacingModel: 'steady' } }, 'text', null, []]) {
    expect(carriedPacingModel(raw)).toBeNull();
  }
});

test('the legacy model maps to Even days in a trickle rhythm, with one notice, and the keys are dropped loudly', () => {
  let out = DEFAULT_DOC;
  const lines = logged(() => {
    out = retireLegacyPacing(DEFAULT_DOC, 'legacy', NOW);
  });
  expect(out.intent).toEqual({ ...DEFAULT_DOC.intent, consistency: 'clockwork', rhythm: 'trickle' });
  expect(out.migration).toEqual({ at: NOW, fromV1: null, notes: [{ kind: 'legacy-pacing-retired' }], bookkeeping: null });
  expect(lines).toEqual([expect.stringMatching(/^warn .*retired pacer keys/)]);
  expect(RETIRED_PACER_KEYS).toEqual(['pacingModel', 'minDelayMinutes', 'maxDelayMinutes', 'jitterPercent']);
});

test('the mapping applies once: a document already noted keeps the choices made since', () => {
  const mapped = retireLegacyPacing(DEFAULT_DOC, 'legacy', NOW);
  const changed = { ...mapped, intent: { ...mapped.intent, consistency: 'natural' as const, rhythm: 'sessions' as const } };
  logged(() => expect(retireLegacyPacing(changed, 'legacy', NOW + 1)).toBe(changed));
});

test('the organic model and an uncarried document change nothing', () => {
  logged(() => expect(retireLegacyPacing(DEFAULT_DOC, 'organic', NOW)).toBe(DEFAULT_DOC));
  expect(logged(() => expect(retireLegacyPacing(DEFAULT_DOC, null, NOW)).toBe(DEFAULT_DOC))).toEqual([]);
});
