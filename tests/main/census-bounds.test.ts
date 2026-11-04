import { censusWalkMax } from '@/kernel/plan/reads';
import { censusBounds } from '@/main/services/census-bounds';
import { sessionPlanRig } from '../kit/harness-plan';

test('a census reserves both lists inside the actual host session, with a too-large answer before any walk', () => {
  const rig = sessionPlanRig();
  try {
    const view = rig.plan.service.view(rig.clock.now());
    const bound = censusBounds(view, { followers: 500_000 }, 10);
    expect(bound.followers + bound.following).toBeGreaterThan(bound.walkMax);
    expect(bound.following).toBe(2);
    const close = view.open === null ? null : view.sessions[view.open.idx].closesAt;
    expect(bound.walkMax).toBe(censusWalkMax({ remainingMs: (close ?? view.at) - view.at, tempo: view.tempo }));
    expect(censusBounds({ ...view, open: null }, { followers: 1 }, 10).walkMax).toBe(0);
  } finally { rig.dispose(); }
});
