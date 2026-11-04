/** The production graph's seams stay wired together after every stream has landed (workplan I.4.1). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as protection from '@/engine/protection-port';
import type { PushMethod } from '@/ipc/contract';
import { PENDING_CONSUMERS } from '@/kernel/tempo/pending';
import type { Foundation } from '@/main/foundation-wiring';
import { PROJECTIONS } from '@/main/modules/projections';
import * as clickReview from '@/main/services/click-review';
import type { BuiltGraph } from '@/main/services/graph-types';
import * as liveWiring from '@/main/services/live-wiring';
import type { PlanWiring } from '@/main/services/plan-wiring';
import * as reopen from '@/main/services/reopen-wiring';
import * as health from '@/main/services/surface-health-sink';
import * as surfaceReport from '@/main/services/surface-report';
import * as surface from '@/main/services/surface-wiring';
import { NOT_BUILT_FIELDS } from '@/shared/status-fields';
import { POLL } from '@/timing/config';
import { cleanupMainHarness, newFoundation } from '../kit/main-harness';

jest.mock('@/engine/protection-port', () => {
  const actual = jest.requireActual('@/engine/protection-port');
  return { ...actual, createProtectionPort: jest.fn(actual.createProtectionPort) };
});
jest.mock('@/main/services/click-review', () => {
  const actual = jest.requireActual('@/main/services/click-review');
  return { ...actual, createClickReview: jest.fn(actual.createClickReview) };
});
jest.mock('@/main/services/live-wiring', () => {
  const actual = jest.requireActual('@/main/services/live-wiring');
  return { ...actual, liveSources: jest.fn(actual.liveSources) };
});
jest.mock('@/main/services/reopen-wiring', () => {
  const actual = jest.requireActual('@/main/services/reopen-wiring');
  return { ...actual, wireFollowback: jest.fn(actual.wireFollowback) };
});
jest.mock('@/main/services/surface-health-sink', () => {
  const actual = jest.requireActual('@/main/services/surface-health-sink');
  return { ...actual, createSurfaceHealthSink: jest.fn(actual.createSurfaceHealthSink) };
});
jest.mock('@/main/services/surface-report', () => {
  const actual = jest.requireActual('@/main/services/surface-report');
  return { ...actual, createSurfaceReport: jest.fn(actual.createSurfaceReport) };
});
jest.mock('@/main/services/surface-wiring', () => {
  const actual = jest.requireActual('@/main/services/surface-wiring');
  return { ...actual, wireSurface: jest.fn(actual.wireSurface) };
});
const reviewSpy = jest.mocked(clickReview.createClickReview);
const liveSourcesSpy = jest.mocked(liveWiring.liveSources);
const protectionSpy = jest.mocked(protection.createProtectionPort);
const reopenSpy = jest.mocked(reopen.wireFollowback);
const sinkSpy = jest.mocked(health.createSurfaceHealthSink);
const reportSpy = jest.mocked(surfaceReport.createSurfaceReport);
const surfaceSpy = jest.mocked(surface.wireSurface);
let foundation: Foundation;
let graph: BuiltGraph;
const pushed: PushMethod[] = [];

beforeAll(async () => {
  jest.useFakeTimers();
  foundation = newFoundation({ catchUp: true, push: (channel) => { pushed.push(channel); } }).foundation;
  expect(await foundation.ensureBuilt()).toBe(true);
  graph = (foundation as unknown as { graph: BuiltGraph }).graph;
});
afterAll(async () => {
  await foundation?.dispose();
  jest.restoreAllMocks();
  jest.useRealTimers();
  cleanupMainHarness();
});

test('every settings capability is enabled and the production startup includes catch-up', () => {
  const capabilities = foundation.settings.view().capabilities;
  expect(Object.keys(capabilities).sort()).toEqual(['boost', 'plan', 'protectionEverywhere', 'tempo']);
  expect(Object.values(capabilities).every(Boolean)).toBe(true);
  expect(graph.startupSteps.map((step) => step.name)).toContain('catch-up');
});

test('every status field has a contributor in the built graph', async () => {
  const status = await foundation.status();
  const boot = (foundation as unknown as { bootFields: BuiltGraph['statusContributors'] }).bootFields;
  const fields = Object.assign({ basis: 'built' }, ...[...graph.statusContributors, ...boot]
    .map((contributor) => contributor.contribute(graph, graph.clock.now())));
  for (const key of Object.keys(NOT_BUILT_FIELDS)) {
    expect(Object.hasOwn(fields, key)).toBe(true);
    expect(Object.hasOwn(status, key)).toBe(true);
  }
});

test('all five graph projections push on build and on a new measured follower', async () => {
  const channels = PROJECTIONS.map((row) => row.channel);
  expect(channels).toHaveLength(5);
  expect(pushed).toEqual(expect.arrayContaining(channels));
  pushed.length = 0;
  graph.store.ensureFollowersBaseline(graph.clock.now() - 1);
  graph.store.observeOwnFollowerEvent('composition-follower', graph.ownPk, graph.clock.now());
  await jest.advanceTimersByTimeAsync(POLL.GRAPH_PUSH_THROTTLE_MS);
  expect(pushed).toEqual(expect.arrayContaining(channels));
});

test('rate, protection, surface accounting and reopen use the same plan-day clock', () => {
  const day = graph.plan.dayClock;
  expect((graph.rate as unknown as { day: unknown }).day).toBe(day);
  expect(protectionSpy.mock.calls).toHaveLength(2);
  for (const [deps] of protectionSpy.mock.calls) expect(deps.dayClock).toBe(day);
  expect(sinkSpy.mock.calls[0][0].day).toBe(day);
  expect(reportSpy.mock.calls[0][0].day).toBe(day);
  expect(reopenSpy.mock.calls[0][1].plan.dayClock).toBe(day);
  expect(liveSourcesSpy.mock.calls[0][2].planDay).toBe(day);
  const churn = graph.churn as unknown as { reconciler: { d: { dayClock: unknown } } };
  expect(churn.reconciler.d.dayClock).toBe(day);
  expect(day.window(graph.clock.now())).toEqual(graph.plan.service.view(graph.clock.now()).window);
});

test('every discovery freshness consumer shares the graph day and the seed service delegates to it', () => {
  const chain = graph.chain as unknown as { frontier: unknown; ownFollowers: unknown };
  for (const consumer of [graph.scanner, graph.acquisition, graph.chain, chain.frontier, chain.ownFollowers]) {
    expect((consumer as { planDay: unknown }).planDay).toBe(graph.plan.dayClock);
  }
  const seed = foundation.seed as unknown as { planDay: Pick<PlanWiring['dayClock'], 'window'> };
  const window = jest.spyOn(graph.plan.dayClock, 'window');
  const now = graph.clock.now();
  expect(seed.planDay.window(now)).toEqual(graph.plan.service.view(now).window);
  expect(window).toHaveBeenCalledWith(now);
  window.mockRestore();
});

test('the profile visitor, composed list walker and notifications drawer share the plan activity clock', () => {
  const plan = graph.plan as PlanWiring;
  const wiring = reopenSpy.mock.calls[0][1];
  expect((graph.profiles as unknown as { activity: unknown }).activity).toBe(plan.activity);
  expect((wiring.walker as unknown as { activity: unknown }).activity).toBe(plan.activity);
  const sweep = reopenSpy.mock.results[0].value.sweep as unknown as { p: { feed: { activity: unknown } } };
  expect(sweep.p.feed.activity).toBe(plan.activity);
  const acquisition = graph.acquisition as unknown as { pageReader: { activity: unknown } };
  expect(acquisition.pageReader.activity).toBe(plan.activity);
});

test('click review calls real plan admission and refuses before a profile read', async () => {
  const review = reviewSpy.mock.calls[0][0];
  expect(review.preflight).toBeDefined();
  const now = graph.clock.now();
  const view = graph.plan.service.view(now);
  const admitted = jest.fn().mockReturnValue({ ok: false, reason: 'ceiling', until: view.window.endsAt });
  const planRead = jest.spyOn(graph.plan.service, 'view').mockReturnValue({ ...view, admits: admitted });
  expect(review.preflight?.('unfollow', 'manual', now, { pk: 'subject' }))
    .toEqual({ ok: false, reason: 'ceiling', until: view.window.endsAt });
  expect(admitted).toHaveBeenCalledWith('unfollow', 'manual', { pk: 'subject' });
  const visit = jest.spyOn(graph.profiles, 'visit');
  await expect(reviewSpy.mock.results[0].value.prepareProfile('subject', 'subject', 'unfollow'))
    .rejects.toThrow('deferred before the visit: ceiling');
  expect(visit).not.toHaveBeenCalled();
  visit.mockRestore();
  planRead.mockRestore();
});

test('the click review reads the live surface gate', () => {
  const review = reviewSpy.mock.calls[0][0];
  const live = surfaceSpy.mock.results[0].value;
  const gate = jest.spyOn(live.gate, 'paused').mockReturnValue(true);
  expect(review.surfaceGate?.paused('unfollows')).toBe(true);
  expect(gate).toHaveBeenCalledWith('unfollows');
  gate.mockRestore();
});

test('no unconnected module or tempo consumer remains', () => {
  const pending = JSON.parse(fs.readFileSync(path.join(__dirname, '../tooling/pending-wiring.json'), 'utf8'));
  expect(pending.pending).toEqual([]);
  expect(PENDING_CONSUMERS).toEqual([]);
});
