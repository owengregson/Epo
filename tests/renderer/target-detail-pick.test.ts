/**
 * `pickDetailTarget` — which target the Targets console details. The engine's
 * current target wins when the chain knows it; otherwise the picker mirrors
 * `Engine.adoptCurrent` (the ACTIVE target at the front of the chain), and an
 * all-terminal chain still details its last node so the funnel can label it
 * truthfully (e.g. "exhausted (unworked)") instead of going blank.
 */
import { pickDetailTarget } from '@/renderer/hooks/useTargetDetail';
import type { ChainTargetView, TargetYield } from '@/types';

const ZERO_YIELD: TargetYield = {
  total: 0,
  followedBack: 0,
  followBackRate: 0,
  poolSize: 0,
  mutualOverlap: 0,
};

const t = (over: Partial<ChainTargetView> & { accountPk: string }): ChainTargetView => ({
  source: 'discovered',
  status: 'active',
  chainIndex: null,
  username: null,
  yield: ZERO_YIELD,
  ...over,
});

test('empty chain → null', () => {
  expect(pickDetailTarget([], null)).toBeNull();
  expect(pickDetailTarget([], 'X')).toBeNull();
});

test("the engine's current target wins when the chain knows it", () => {
  const chain = [t({ accountPk: 'A', chainIndex: 0 }), t({ accountPk: 'B', chainIndex: 1 })];
  expect(pickDetailTarget(chain, 'A')).toBe('A');
});

test('a current pk the chain does not know falls through to the active front', () => {
  const chain = [
    t({ accountPk: 'A', chainIndex: 0, status: 'exhausted' }),
    t({ accountPk: 'B', chainIndex: 1 }),
  ];
  expect(pickDetailTarget(chain, 'GHOST')).toBe('B');
});

test('no current → the ACTIVE target with the highest chain index (adoption order)', () => {
  const chain = [
    t({ accountPk: 'A', chainIndex: 0, status: 'exhausted' }),
    t({ accountPk: 'B', chainIndex: 1 }),
    t({ accountPk: 'C', chainIndex: 2, status: 'retained' }),
  ];
  expect(pickDetailTarget(chain, null)).toBe('B');
});

test('an all-terminal chain still details its last node (the funnel labels it)', () => {
  const chain = [
    t({ accountPk: 'A', chainIndex: 0, status: 'exhausted' }),
    t({ accountPk: 'B', chainIndex: 1, status: 'exhausted' }),
  ];
  expect(pickDetailTarget(chain, null)).toBe('B');
});
