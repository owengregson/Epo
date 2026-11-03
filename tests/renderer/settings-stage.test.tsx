/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The Settings stage (spec §6.4–§6.8): one apply per control, honest reverts, Undo, a mode switch that
 * sends only a `ui` op, capability hiding, the notices and the refused-migration sheet.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { ShellContext, settingsViewSignal } from '@/renderer/app/shell-context';
import { GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { resetAtLimitAcknowledgement } from '@/renderer/settings/at-limit';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { SettingsOp, SettingsSaveResult } from '@/shared/settings-ops';
import type { SettingsView } from '@/shared/settings-view';
import { type FakeBridge, installFakeBridge } from '../kit/render-bridge';

let bridge: FakeBridge;
let confirmAnswer = true;
const confirm = jest.fn(async () => confirmAnswer);
const shell = (node: ComponentChildren) => (
  <ShellContext.Provider value={{ confirm, toast: jest.fn() }}>{node}</ShellContext.Provider>
);
const view = (over: Partial<SettingsView> = {}): SettingsView => ({ ...GALLERY_SETTINGS_VIEW, ...over });
const saved = (v: SettingsView, inverse: SettingsOp[] = []): SettingsSaveResult =>
  ({ kind: 'saved', view: v, adjustments: [], conflicts: [], applies: [], inverse });
const applyCalls = () => bridge.calls.filter((c) => c[0] === 'applySettings').map((c) => c[1]);

async function mount(v: SettingsView = view()): Promise<void> {
  settingsViewSignal.value = v;
  bridge.data.settingsView = v;
  render(shell(<SettingsStage />));
  await screen.findByRole('heading', { name: 'Settings', level: 1 });
}

beforeEach(() => {
  bridge = installFakeBridge(DEFAULT_SETTINGS);
  confirm.mockClear();
  confirmAnswer = true;
  resetAtLimitAcknowledgement();
});

describe('the Settings stage shell', () => {
  it('says when the settings could not load, and Retry pulls again', async () => {
    bridge.failNext('settingsView', 'gone');
    render(shell(<SettingsStage />));
    await screen.findByText(/Couldn’t load your settings/);
    fireEvent.click(screen.getByText('Retry'));
    await screen.findByRole('heading', { name: 'Growth pace' });
  });

  it('the mode switch sends only a ui op and keeps every value', async () => {
    await mount();
    bridge.stub('applySettings', () => saved(view({ rev: 8, mode: 'advanced' })));
    fireEvent.click(screen.getByRole('radio', { name: 'Advanced' }));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'ui', mode: 'advanced' }]]));
    await screen.findByRole('heading', { name: 'Under the hood' });
  });

  it('hides Boost while the plan’s Boost is not wired, and Timing until the plan tempo is', async () => {
    await mount(view({ mode: 'advanced', capabilities: { plan: true, tempo: false, boost: false, protectionEverywhere: true } }));
    expect(screen.queryByRole('heading', { name: 'Boost' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Timing' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Finding new people' })).toBeTruthy();
  });

  it('shows only the seven Easy sections in Easy', async () => {
    await mount();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(['Growth pace', 'When Epo works', 'Who to follow', 'Unfollowing', 'Protection', 'Boost', 'Practice & app']);
  });

  it('a newer pushed view replaces the shown one; an older one is ignored', async () => {
    await mount(view({ rev: 7 }));
    await act(async () => {
      settingsViewSignal.value = view({ rev: 9, notices: [{ id: 'n', tone: 'info', kind: 'everything-in-advanced', data: {}, dismissible: true }] });
    });
    expect(screen.getByText('Everything you could set before is in Advanced.')).toBeTruthy();
    await act(async () => {
      settingsViewSignal.value = view({ rev: 8 });
    });
    expect(screen.getByText('Everything you could set before is in Advanced.')).toBeTruthy();
  });

  it('the refused-migration sheet sends only migration ops', async () => {
    await mount(view({
      health: { kind: 'migration-refused', detail: 'lists' },
      notices: [{ id: 'health:migration-refused', tone: 'error', kind: 'migration-refused', data: {}, dismissible: false }],
    }));
    bridge.stub('applySettings', () => ({ kind: 'refused', reason: 'migration-pending', detail: 'still', view: view() }));
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'migration', action: 'retry' }]]));
    fireEvent.click(screen.getByText('Start from recommended settings'));
    await waitFor(() => expect(applyCalls()).toHaveLength(2));
    expect(applyCalls()[1]).toEqual([{ op: 'migration', action: 'start-from-recommended' }]);
  });

  it('a protection review notice acknowledges with its own op', async () => {
    await mount(view({ protectionState: 'needs-review', notices: [{ id: 'protection:needs-review', tone: 'warning', kind: 'needs-review', data: {}, dismissible: false }] }));
    fireEvent.click(screen.getByText('My protection list is right'));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'acknowledge-protection' }]]));
  });
});
