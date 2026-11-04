/**
 * The refill pipeline reads the plan (spec §5.16, §17.8): the bootstrap waits the idle beat until the
 * frontier's own instant, and a read refusal with no instant of its own defers reads to the plan-day end.
 */

import type { EngineAcquisition, EngineEnricher, EngineScanner } from '@/engine/ports';
import type { SourceFrontier } from '@/engine/source-frontier';
import { TargetPipeline, type TargetPipelineDeps } from '@/engine/target-pipeline';
import { FakeClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { HOUR } from '../kit/engine-harness';
import { stubPlanView } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

const T0 = Date.parse('2026-08-12T12:00:00');

let store: KnowledgeStore;
beforeEach(() => {
  store = openTestStore(':memory:');
});
afterEach(() => store.close());

function pipeline(over: { frontierResumeAt?: number | null; acquisition?: EngineAcquisition }) {
  const clock = new FakeClock(T0);
  const idles: number[][] = [];
  const frontier = over.frontierResumeAt === undefined ? undefined : ({
    snapshot: () => ({ sources: [{ pk: 'src' }] }),
    nextResumeAt: () => over.frontierResumeAt ?? null,
  } as unknown as SourceFrontier);
  const view = stubPlanView(T0, { open: true, nextSessionAt: null, target: 25 });
  const deps: TargetPipelineDeps = {
    store, clock, frontier,
    acquisition: over.acquisition ?? ({ acquire: async () => ({ observed: 0, targetPk: null, endReason: 'no-more-pages' }) } as EngineAcquisition),
    scanner: { planTarget: () => ({ queued: [], skipped: [] }) } as unknown as EngineScanner,
    enricher: { enrich: async () => 0 } as EngineEnricher,
    settings: () => ({ ...DEFAULT_SETTINGS, seed: 'seedling' }),
    plan: { view: () => view, dayWindow: (t) => calendarPlanDayClock({ now: () => t }).window(t) },
    idle: async (events) => {
      idles.push([...events]);
      return { completed: true };
    },
    wait: async () => ({ completed: true }),
    recover: async () => 'recovering',
    halt: () => 'halted',
  };
  return { targets: new TargetPipeline(deps), idles, view };
}

test('with sources on the frontier, the bootstrap idles until the frontier resumes — never a fixed beat', async () => {
  const { targets, idles } = pipeline({ frontierResumeAt: T0 + 10_000 });
  expect(await targets.bootstrapSeedTarget()).toBe('idle');
  expect(idles).toEqual([[T0 + 10_000]]);
});

test('a frontier with no resume instant leaves the idle beat to its own bound', async () => {
  const { targets, idles } = pipeline({ frontierResumeAt: null });
  expect(await targets.bootstrapSeedTarget()).toBe('idle');
  expect(idles).toEqual([[]]);
});

test("a read refusal with no instant of its own defers reads to the plan-day's end, then idles to it", async () => {
  const acquisition = { acquire: async () => ({ observed: 0, targetPk: null, endReason: 'read-budget' }) } as EngineAcquisition;
  const { targets, idles, view } = pipeline({ acquisition });
  expect(await targets.bootstrapSeedTarget()).toBe('idle');
  expect(targets.refillAvailableAt()).toBe(view.window.endsAt);
  expect(idles).toEqual([[view.window.endsAt]]);
  expect(view.window.endsAt - T0).toBeLessThanOrEqual(24 * HOUR + HOUR);
});
