/**
 * The Settings change queue (spec §6.8): sequential sends, coalescing per key, revert on not-saved,
 * older-rev pushes ignored, and pending overlays kept on top of a newer view.
 */
import { GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { ChangeQueue, type SendFn } from '@/renderer/settings/change-queue';
import type { SettingsOp, SettingsSaveResult } from '@/shared/settings-ops';
import type { SettingsView } from '@/shared/settings-view';

const viewAt = (rev: number): SettingsView => ({ ...GALLERY_SETTINGS_VIEW, rev });
const op = (activity: 'light' | 'moderate' | 'active'): SettingsOp => ({ op: 'intent', key: 'activity', value: activity });
const saved = (rev: number, inverse: SettingsOp[] = []): SettingsSaveResult =>
  ({ kind: 'saved', view: viewAt(rev), adjustments: [], conflicts: [], applies: [], inverse });

/** A send whose answers the test releases one at a time. */
function gatedSend() {
  const sent: (readonly SettingsOp[])[] = [];
  const resolvers: ((r: SettingsSaveResult) => void)[] = [];
  const send: SendFn = (ops) => {
    sent.push(ops);
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const answer = async (r: SettingsSaveResult): Promise<void> => {
    resolvers.shift()?.(r);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { send, sent, answer };
}

describe('ChangeQueue', () => {
  it('sends one change at a time, in order', async () => {
    const g = gatedSend();
    const q = new ChangeQueue(g.send);
    q.adopt(viewAt(1));
    q.submit('intent:activity', [op('light')], 'light');
    q.submit('intent:caution', [{ op: 'intent', key: 'caution', value: 'bold' }], 'bold');
    expect(g.sent).toHaveLength(1);
    await g.answer(saved(2));
    expect(g.sent).toHaveLength(2);
    expect(g.sent[1]).toEqual([{ op: 'intent', key: 'caution', value: 'bold' }]);
  });

  it('coalesces unsent changes of one control to the newest', async () => {
    const g = gatedSend();
    const q = new ChangeQueue(g.send);
    q.adopt(viewAt(1));
    q.submit('param:pace.hourlyCap', [{ op: 'override', key: 'pace.hourlyCap', value: 21 }], 21);
    q.submit('param:pace.dailyVolume', [{ op: 'override', key: 'pace.dailyVolume', value: 49 }], 49);
    q.submit('param:pace.dailyVolume', [{ op: 'override', key: 'pace.dailyVolume', value: 48 }], 48);
    q.submit('param:pace.dailyVolume', [{ op: 'override', key: 'pace.dailyVolume', value: 47 }], 47);
    expect(q.valueOf('param:pace.dailyVolume', 50)).toBe(47);
    await g.answer(saved(2));
    await g.answer(saved(3));
    expect(g.sent).toEqual([
      [{ op: 'override', key: 'pace.hourlyCap', value: 21 }],
      [{ op: 'override', key: 'pace.dailyVolume', value: 47 }],
    ]);
  });

  it('reverts the control and records why when nothing was saved', async () => {
    const g = gatedSend();
    const q = new ChangeQueue(g.send);
    q.adopt(viewAt(4));
    q.submit('intent:activity', [op('active')], 'active');
    expect(q.valueOf('intent:activity', 'moderate')).toBe('active');
    await g.answer({ kind: 'not-saved', view: viewAt(4), detail: 'disk full' });
    expect(q.valueOf('intent:activity', 'moderate')).toBe('moderate');
    expect(q.state().errors.get('intent:activity')).toBe('disk full');
    expect(q.state().save).toEqual({ kind: 'failed', detail: 'disk full', reason: 'not-saved' });
    q.retry();
    expect(g.sent).toEqual([[op('active')], [op('active')]]);
  });

  it('reverts when the bridge itself rejects', async () => {
    const q = new ChangeQueue(() => Promise.reject(new Error('gone')));
    q.submit('intent:activity', [op('active')], 'active');
    await Promise.resolve();
    await Promise.resolve();
    expect(q.valueOf('intent:activity', 'moderate')).toBe('moderate');
    expect(q.state().save).toMatchObject({ kind: 'failed', reason: 'unreachable' });
  });

  it('adopts the saved view by rev and offers its inverse as Undo', async () => {
    const g = gatedSend();
    const q = new ChangeQueue(g.send);
    q.adopt(viewAt(1));
    q.submit('intent:activity', [op('light')], 'light');
    await g.answer(saved(2, [op('moderate')]));
    expect(q.state().view?.rev).toBe(2);
    expect(q.state().save).toEqual({ kind: 'saved', key: 'intent:activity', inverse: [op('moderate')], adjusted: 0 });
    q.undo();
    expect(g.sent.at(-1)).toEqual([op('moderate')]);
  });

  it('ignores a push older than the adopted view', () => {
    const q = new ChangeQueue(gatedSend().send);
    q.adopt(viewAt(5));
    q.adopt(viewAt(3));
    q.adopt(viewAt(5));
    expect(q.state().view?.rev).toBe(5);
    q.adopt(viewAt(6));
    expect(q.state().view?.rev).toBe(6);
  });

  it('keeps a pending overlay on top of a newer pushed view', async () => {
    const g = gatedSend();
    const q = new ChangeQueue(g.send);
    q.adopt(viewAt(1));
    q.submit('intent:activity', [op('light')], 'light');
    q.adopt(viewAt(2));
    expect(q.state().view?.rev).toBe(2);
    expect(q.valueOf('intent:activity', 'moderate')).toBe('light');
    // An older answer for the same key never clears a newer change's overlay.
    q.submit('intent:activity', [op('active')], 'active');
    await g.answer(saved(3));
    expect(q.valueOf('intent:activity', 'moderate')).toBe('active');
    await g.answer(saved(4));
    expect(q.valueOf('intent:activity', 'moderate')).toBe('moderate');
  });
});
