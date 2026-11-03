/**
 * The stage controller (spec §12.4, Appendix C.3): the one entry point for the stage. It validates, serializes
 * (latest request wins), enters Live through the veil curtain with a plain-cut fallback, leaves Live at once,
 * titles the window per posture and badges the Dock only for alert kinds. Concealment is always re-stacking:
 * the tab's native visibility is never switched off.
 */

import type { WebContentsView } from 'electron';
import { TabPlacement } from '@/adapter/tab-placement';
import { createStageController, postureOfStatus } from '@/main/window/stage-controller';
import { derivePosture } from '@/shared/posture';
import type { StageMode } from '@/shared/stage-mode';
import type { EpoStatus } from '@/types';
import { idleStatus } from '../kit/render-bridge';

type Curtain = 'opaque' | 'clear' | 'off';

function rig(paint: (state: Curtain) => Promise<boolean> = async () => true) {
  const log: string[] = [];
  const tabView = { setVisible: jest.fn() };
  const host = { contentView: { children: [] as unknown[], addChildView: jest.fn() } };
  const placement = new TabPlacement(tabView as unknown as WebContentsView);
  placement.attach(host as never);
  const win = { setTitle: jest.fn(), getTitle: jest.fn(() => 'Epo') };
  const badges: string[] = [];
  const stage = createStageController({
    shell: {
      win: win as never,
      setStage: (mode: StageMode, covered: boolean) => {
        log.push(`stage:${mode}:${covered}`);
        if (mode === 'tab' && !covered) placement.show();
        else placement.hide();
      },
    },
    veil: { curtain: async (state: Curtain) => { log.push(`curtain:${state}`); return paint(state); } },
    dock: { setBadge: (text: string) => { badges.push(text); } },
    timing: { paintMaxMs: 101, fadeMs: 300 },
  });
  return { stage, log, tabView, win, badges };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('cover() puts the tab under the dashboard from frame 1; entering Live runs the curtain in order', async () => {
  const r = rig();
  r.stage.cover();
  expect(r.stage.current()).toEqual({ mode: 'tab', covered: true });
  await r.stage.set('tab', false);
  expect(r.log).toEqual(['stage:tab:true', 'curtain:opaque', 'stage:tab:false', 'curtain:clear', 'curtain:off']);
  expect(r.stage.current()).toEqual({ mode: 'tab', covered: false });
});

test('leaving Live is instant, and a repeat request is a no-op', async () => {
  const r = rig();
  await r.stage.set('tab', false);
  r.log.length = 0;
  await r.stage.set('graph', false);
  await r.stage.set('graph', false);
  expect(r.log).toEqual(['stage:graph:false']);
});

test('an unpainted curtain falls back to a plain cut within the paint bound', async () => {
  jest.useFakeTimers();
  try {
    const r = rig(async (state) => (state === 'opaque' ? new Promise<boolean>(() => {}) : true));
    r.stage.cover();
    const entering = r.stage.set('tab', false);
    await jest.advanceTimersByTimeAsync(101);
    await entering;
    expect(r.log).toEqual(['stage:tab:true', 'curtain:opaque', 'stage:tab:false', 'curtain:off']);
  } finally {
    jest.useRealTimers();
  }
});

test('requests serialize and the latest wins', async () => {
  let release!: () => void;
  const r = rig(async (state) => {
    if (state === 'opaque') await new Promise<void>((resolve) => { release = resolve; });
    return true;
  });
  r.stage.cover();
  const first = r.stage.set('tab', false);
  await flush();
  const second = r.stage.set('people', false);
  const third = r.stage.set('settings', false);
  release();
  await Promise.all([first, second, third]);
  expect(r.log.filter((l) => l.startsWith('stage:')).slice(-1)).toEqual(['stage:settings:false']);
  expect(r.log).not.toContain('stage:people:false');
  expect(r.stage.current()).toEqual({ mode: 'settings', covered: false });
});

test('an unknown mode is refused and logged, and changes nothing', async () => {
  const r = rig();
  await r.stage.set('tab', false);
  r.log.length = 0;
  await r.stage.set('nowhere' as StageMode, false);
  expect(r.log).toEqual([]);
});

test('the tab is never hidden by native visibility, whatever the sequence', async () => {
  const r = rig();
  r.stage.cover();
  for (const [mode, covered] of [['tab', false], ['graph', false], ['tab', true], ['prune', false], ['tab', false],
    ['settings', true], ['people', false]] as Array<[StageMode, boolean]>) {
    await r.stage.set(mode, covered);
  }
  expect(r.tabView.setVisible).not.toHaveBeenCalledWith(false);
});

test('the title follows the posture headline; the Dock badge shows only for alert kinds', () => {
  const r = rig();
  const at = (s: Partial<EpoStatus>) => derivePosture(postureOfStatus({ ...idleStatus(), ...s }), 0);
  r.stage.onPosture(at({ state: 'running', lastStep: { kind: 'follow' } as never, nextActionAt: 5 }));
  r.stage.onPosture(at({ state: 'halted', haltReason: 'rate-limited' }));
  r.stage.onPosture(at({ state: 'idle' }));
  expect(r.win.setTitle.mock.calls.map((c) => c[0])).toEqual(['Epo — Working', 'Epo — Needs attention', 'Epo — Stopped']);
  expect(r.badges).toEqual(['', '!', '']);
});
