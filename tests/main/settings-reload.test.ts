/**
 * The diffed reload (spec §6.6, §7.4): a protection edit re-applies the unfollow rules at once (the engine
 * running or stopped), the churn config carries the intent's mutuals choice, and an unrelated edit reloads nothing.
 */
import { reloadChanged } from '@/main/modules/settings-reload';
import type { BuiltGraph } from '@/main/services/graph-types';
import { effectiveFromV1 } from '@/settings/effective';
import type { Touched } from '@/settings/ops';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';

function graph() {
  const churn = { applyConfig: jest.fn() };
  const g = {
    churn, rate: { applyConfig: jest.fn() }, scanner: { applyConfig: jest.fn() }, followback: { applyConfig: jest.fn() },
    chain: { applyConfig: jest.fn() }, pruneEngine: { applyConfig: jest.fn() }, churnActions: { setDryRun: jest.fn() },
    engine: { applySettings: jest.fn() },
  };
  return { g: g as unknown as BuiltGraph, churn };
}

const EFFECTIVE = effectiveFromV1(DEFAULT_SETTINGS);
const touched = (...t: Touched[]): ReadonlySet<Touched> => new Set(t);

test('a protection-only change re-applies the unfollow rules at once', () => {
  const { g, churn } = graph();
  const reloaded = reloadChanged(g, EFFECTIVE, EFFECTIVE, { prev: EFFECTIVE, next: EFFECTIVE, touched: touched('protection') });
  expect(reloaded).toEqual(['churn']);
  expect(churn.applyConfig).toHaveBeenCalledWith(expect.objectContaining({ rotateMutuals: true }));
});

test("the churn config carries the intent's mutuals choice", () => {
  const { g, churn } = graph();
  const next = { ...EFFECTIVE, rotateMutuals: false };
  expect(reloadChanged(g, EFFECTIVE, EFFECTIVE, { prev: EFFECTIVE, next, touched: touched('intent') })).toEqual(['churn']);
  expect(churn.applyConfig).toHaveBeenCalledWith(expect.objectContaining({ rotateMutuals: false }));
});

test('an edit that moves no projected config reloads nothing', () => {
  const { g, churn } = graph();
  expect(reloadChanged(g, EFFECTIVE, EFFECTIVE, { prev: EFFECTIVE, next: EFFECTIVE, touched: touched('seed') })).toEqual([]);
  expect(churn.applyConfig).not.toHaveBeenCalled();
});


test('Advanced audience overrides reach the running scorer on reload', () => {
  const { g } = graph();
  const next = { ...EFFECTIVE, bandEdgeScore: 0.2, mutualCap: 7, mutualWeight: 0.6 };
  expect(reloadChanged(g, EFFECTIVE, next, { prev: EFFECTIVE, next, touched: touched('overrides') })).toEqual(['scanner']);
  expect(g.scanner.applyConfig).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    bandEdgeScore: 0.2, mutualCap: 7, mutualWeight: 0.6,
  }));
});
