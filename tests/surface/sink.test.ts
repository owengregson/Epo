/**
 * The surface sink seam (F2a step 8): the read pipeline reports every read's
 * tally and every drift signal to a sink. Phase F lands the port, an in-memory
 * sink and the record-nothing default; the parse-health stream wires a real one.
 */
import { type DriftSignal, MemorySink, NO_SINK, type SurfaceSink } from '@/surface/sink';

const signal: DriftSignal = { endpoint: 'activity-feed', cls: 'novel-key', path: 'data.*.edges', detail: { key: 'x' } };

test('MemorySink keeps every read and drift report, in order, without sampling bodies', () => {
  const sink = new MemorySink();
  let sampled = 0;
  sink.read('profile-graphql', 'canonical', { rows: 0, fields: 0 }, 10);
  sink.drift({ ...signal, sample: () => { sampled += 1; return {}; } }, 11);
  sink.read('followers-list', 'failed', { rows: 2, fields: 1 }, 12);
  const snap = sink.snapshot();
  expect(snap.reads).toEqual([
    { endpoint: 'profile-graphql', tally: 'canonical', rows: 0, fields: 0, at: 10 },
    { endpoint: 'followers-list', tally: 'failed', rows: 2, fields: 1, at: 12 },
  ]);
  expect(snap.drift.map((d) => [d.signal.cls, d.at])).toEqual([['novel-key', 11]]);
  expect(sampled).toBe(0);
});

test('a snapshot is a copy: later reports never change it', () => {
  const sink = new MemorySink();
  const before = sink.snapshot();
  sink.drift(signal, 1);
  expect(before.drift).toEqual([]);
});

test('NO_SINK is a sink that records nothing', () => {
  const sink: SurfaceSink = NO_SINK;
  expect(() => { sink.read('route', 'wall', { rows: 0, fields: 0 }, 1); sink.drift(signal, 1); }).not.toThrow();
});
