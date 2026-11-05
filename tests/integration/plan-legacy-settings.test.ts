/**
 * I7 (spec §20.3, §5.13 S2 item 8): a legacy settings file loads, drops the retired pacer's keys loudly,
 * maps its legacy model once to Even days in a trickle rhythm with the notice, and the plan runs on what
 * it became; a document a pre-switch build wrote with `legacyCarry` takes the same path.
 */
import { SCALES } from '@/kernel/policy';
import { SettingsService } from '@/main/modules/settings-service';
import type { PlanHost } from '@/main/services/graph-types';
import { type PlanWiring, wirePlan } from '@/main/services/plan-wiring';
import { DEFAULT_DOC } from '@/settings/doc';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { toPlanIntent } from '@/settings/plan-intent';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { DelayManager } from '@/timing/delay-manager';
import { ScheduleManager } from '@/timing/schedule-manager';
import { setLevel, setSink } from '@/utils/logger';
import { busyDay, PLAN_TEST_RNG, planClock } from '../kit/harness-plan';
import { memoryFs } from '../kit/settings';
import { openTestStore } from '../kit/store';

const FROM = Date.parse('2026-11-09T12:00:00');
const PACER_KEYS = ['pacingModel', 'minDelayMinutes', 'maxDelayMinutes', 'jitterPercent'];
const opened: { plan: PlanWiring; store: KnowledgeStore }[] = [];
afterEach(() => {
  while (opened.length > 0) {
    const o = opened.pop();
    o?.plan.dispose();
    o?.store.close();
  }
});

/** A settings service over `files`, with the warnings its construction logged. */
function open(files: Record<string, string>) {
  const m = memoryFs(files);
  const lines: string[] = [];
  setLevel('warn');
  setSink((level, message) => lines.push(`${level} ${message}`));
  try {
    const svc = new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => true, now: () => FROM, push: () => {} });
    return { svc, m, lines };
  } finally {
    setSink(null);
    setLevel('error');
  }
}

const hostOf = (svc: SettingsService): PlanHost => ({
  runIntent: () => 'running',
  pushStatus: () => {},
  settings: {
    effective: () => svc.effective(), onChange: (fn) => svc.onChange(() => fn()),
    setPlanPort: (port) => svc.setPlanPort(port), setCapabilities: (patch) => svc.setCapabilities(patch),
  },
});

/** The plan wiring over the service's live settings draws a day that acts, on the mapped intent. */
function expectThePlanRuns(svc: SettingsService): void {
  const store = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('ME');
  const clock = planClock(FROM);
  const plan = wirePlan(store, clock, 'ME', new DelayManager({ clock }),
    { plan: hostOf(svc), settings: svc.effective(), scheduler: new ScheduleManager() });
  opened.push({ plan, store });
  expect(svc.effective().pattern).toMatchObject({ consistency: 'clockwork', rhythm: 'trickle' });
  expect(toPlanIntent(svc.effective()).consistencyScale).toBe(SCALES.consistency.clockwork);
  const day = busyDay(plan.service, FROM, 1);
  expect(day.plan.volume.planned).toBeGreaterThan(0);
  expect(day.plan.sessions.some((s) => s.budget > 0)).toBe(true);
}

test('a v1 file on the legacy pacer migrates, drops the pacer keys loudly, and the plan runs on Even + trickle', () => {
  const v1 = JSON.stringify({ ...DEFAULT_SETTINGS, pacingModel: 'legacy', minDelayMinutes: 4, maxDelayMinutes: 9, jitterPercent: 20 });
  const { svc, m, lines } = open({ [F.v1]: v1 });
  expect(lines).toContainEqual(expect.stringMatching(/^warn .*retired pacer keys/));
  const view = svc.view();
  expect(view.health.kind).toBe('migrated');
  expect(view.intent).toMatchObject({ consistency: 'clockwork', rhythm: 'trickle' });
  expect(view.notices.filter((n) => n.kind === 'legacy-pacing-retired')).toHaveLength(1);
  const written = m.data.get(F.v2) ?? '';
  for (const key of [...PACER_KEYS, 'legacyCarry']) expect(written).not.toContain(key);
  for (const key of PACER_KEYS) expect(svc.effective()).not.toHaveProperty(key);
  expectThePlanRuns(svc);
});

test('a document a pre-switch build wrote with legacyCarry maps once, and the next write drops the record', () => {
  const carried = { ...DEFAULT_DOC, rev: 3, legacyCarry: { pacingModel: 'legacy', minDelayMinutes: 4, maxDelayMinutes: 7,
    jitterPercent: 30, activeHoursStart: 8, activeHoursEnd: 22 } };
  const first = open({ [F.v2]: JSON.stringify(carried), [F.created]: '{}' });
  expect(first.lines).toContainEqual(expect.stringMatching(/^warn .*retired pacer keys/));
  expect(first.svc.view().intent).toMatchObject({ consistency: 'clockwork', rhythm: 'trickle' });
  expect(first.svc.view().notices.map((n) => n.kind)).toContain('legacy-pacing-retired');
  expectThePlanRuns(first.svc);

  expect(first.svc.apply([{ op: 'seed', handle: 'friend' }], 'user').kind).toBe('saved');
  const written = first.m.data.get(F.v2) ?? '';
  expect(written).not.toContain('legacyCarry');
  const reopened = open(Object.fromEntries(first.m.data));
  expect(reopened.lines).toEqual([]);
  expect(reopened.svc.view().intent).toMatchObject({ consistency: 'clockwork', rhythm: 'trickle' });
  expect(reopened.svc.view().notices.filter((n) => n.kind === 'legacy-pacing-retired')).toHaveLength(1);
});

test('the organic model keeps the intent it had: no notice, the keys still dropped loudly', () => {
  const v1 = JSON.stringify({ ...DEFAULT_SETTINGS, pacingModel: 'organic' });
  const { svc, lines } = open({ [F.v1]: v1 });
  expect(lines).toContainEqual(expect.stringMatching(/^warn .*retired pacer keys/));
  expect(svc.view().intent).toMatchObject({ consistency: 'natural', rhythm: 'sessions' });
  expect(svc.view().notices.map((n) => n.kind)).not.toContain('legacy-pacing-retired');
});
