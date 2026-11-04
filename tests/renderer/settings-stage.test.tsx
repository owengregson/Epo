/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The Settings stage (spec §6.4–§6.8): one apply per control, honest reverts, Undo, a mode switch that
 * sends only a `ui` op, capability hiding, the notices and the refused-migration sheet.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { ShellContext, settingsFactsSignal, settingsViewSignal } from '@/renderer/app/shell-context';
import { GALLERY_BASIS } from '@/renderer/gallery/fixtures-settings';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { resetBasisCache } from '@/renderer/settings/advanced/BasisTable';
import { resetAtLimitAcknowledgement } from '@/renderer/settings/at-limit';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
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
  bridge = installFakeBridge();
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

describe('the Easy sections', () => {
  const pace = () => screen.getByRole('radiogroup', { name: 'Growth pace' });

  it('one apply per card click, with the card’s two intent ops', async () => {
    await mount();
    bridge.stub('applySettings', () => saved(view({ rev: 8, easy: { ...GALLERY_SETTINGS_VIEW.easy, pace: 'faster' } })));
    fireEvent.click(within(pace()).getByRole('radio', { name: /Faster/ }));
    await waitFor(() => expect(applyCalls()).toEqual([[
      { op: 'intent', key: 'activity', value: 'active' }, { op: 'intent', key: 'caution', value: 'standard' },
    ]]));
    expect(within(pace()).getByRole('radio', { name: /Faster/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('a not-saved answer reverts the card and says nothing was changed', async () => {
    await mount();
    bridge.stub('applySettings', () => ({ kind: 'not-saved', view: view(), detail: 'disk full' }));
    fireEvent.click(within(pace()).getByRole('radio', { name: /Gentle/ }));
    await screen.findByText('Not saved. Nothing was changed.');
    expect(within(pace()).getByRole('radio', { name: /Balanced/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Couldn’t save — nothing was changed.')).toBeTruthy();
  });

  it('Undo sends the saved change’s inverse', async () => {
    await mount();
    const inverse: SettingsOp[] = [{ op: 'intent', key: 'rhythm', value: 'sessions' }];
    bridge.stub('applySettings', () => saved(view({ rev: 8, intent: { ...GALLERY_SETTINGS_VIEW.intent, rhythm: 'trickle' } }), inverse));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Session style' })).getByRole('radio', { name: /Many short visits/ }));
    fireEvent.click(await screen.findByText('Undo'));
    await waitFor(() => expect(applyCalls()[1]).toEqual(inverse));
  });

  it('values set in Advanced show as "Your own mix", never as a wrong card', async () => {
    await mount(view({ easy: { ...GALLERY_SETTINGS_VIEW.easy, pace: 'custom' }, overrides: { count: 1, stale: 0, bySection: { pace: 1 } } }));
    expect(screen.getByText('Your own mix')).toBeTruthy();
    expect(within(pace()).queryAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(0);
    expect(screen.getByText('Fine-tuned in Advanced (1)')).toBeTruthy();
  });

  it('asks once per app session before a change that runs at the known limit', async () => {
    const atLimit = view({
      options: {
        ...GALLERY_SETTINGS_VIEW.options,
        paceCards: GALLERY_SETTINGS_VIEW.options.paceCards.map((p) => (p.id === 'faster' ? { ...p, risk: 'at-limit' } : p)),
      },
    });
    await mount(atLimit);
    bridge.stub('applySettings', () => saved(view({ rev: 8 })));
    fireEvent.click(within(pace()).getByRole('radio', { name: /Faster/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(applyCalls()).toHaveLength(1));
    fireEvent.click(within(pace()).getByRole('radio', { name: /Gentle/ }));
    fireEvent.click(within(pace()).getByRole('radio', { name: /Faster/ }));
    await waitFor(() => expect(applyCalls()).toHaveLength(3));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('turning pruning on asks first with the census numbers; Cancel sends nothing', async () => {
    settingsFactsSignal.value = GALLERY_SETTINGS_FACTS;
    await mount();
    const own = screen.getByRole('radiogroup', { name: 'People you followed yourself' });
    fireEvent.click(within(own).getByRole('radio', { name: /a few a day/ }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Prune people you followed yourself?' });
    expect(sheet.textContent).toMatch(/Epo found 318 accounts you follow that don’t follow you back/);
    expect(sheet.textContent).toMatch(/41 of them are protected/);
    fireEvent.click(within(sheet).getByText('Cancel'));
    expect(applyCalls()).toHaveLength(0);
    fireEvent.click(within(own).getByRole('radio', { name: /a few a day/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Turn on'));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'intent', key: 'cleanup', value: 'trickle' }]]));
  });

  it('the reset sheet lists main’s diff and marks the lines that make Epo unfollow more', async () => {
    await mount();
    bridge.stub('previewSettings', () => ({
      kind: 'ok', view: view(), conflicts: [], adjustments: [],
      changes: [
        { key: 'activity', before: 'active', after: 'moderate', loosensUnfollows: false },
        { key: 'patience', before: 'patient', after: 'normal', loosensUnfollows: true },
      ],
    }));
    fireEvent.click(screen.getByText('Review and reset'));
    const sheet = await screen.findByRole('alertdialog', { name: 'Reset to recommended?' });
    await within(sheet).findByText('Activity level');
    const lines = sheet.querySelectorAll('.set-diff__line');
    expect(lines[0]?.textContent).toMatch(/Active → Moderate/);
    expect(lines[0]?.classList.contains('is-loosening')).toBe(false);
    expect(lines[1]?.textContent).toMatch(/1 week → 4 days/);
    expect(lines[1]?.classList.contains('is-loosening')).toBe(true);
    expect(lines[1]?.textContent).toMatch(/Epo will unfollow more/);
    expect(sheet.textContent).toMatch(/protection list \(3 accounts, 2 keywords\)/);
    expect(bridge.calls.filter((c) => c[0] === 'previewSettings')).toEqual([['previewSettings', [{ op: 'reset', scope: { kind: 'recommended' } }]]]);
    fireEvent.click(within(sheet).getByText('Reset'));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'reset', scope: { kind: 'recommended' } }]]));
  });

  it('days off never reach seven: the seventh day explains Stop instead', async () => {
    await mount(view({ intent: { ...GALLERY_SETTINGS_VIEW.intent, daysOff: [0, 1, 2, 3, 4, 5] } }));
    fireEvent.click(screen.getByRole('button', { name: /Saturday/ }));
    expect(screen.getByText(/Seven days off would stop Epo/)).toBeTruthy();
    expect(applyCalls()).toHaveLength(0);
  });

  it('turning practice mode off asks first', async () => {
    await mount(view({ prefs: { ...GALLERY_SETTINGS_VIEW.prefs, practice: true } }));
    confirmAnswer = false;
    fireEvent.click(screen.getByRole('switch', { name: 'Practice mode' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(applyCalls()).toHaveLength(0);
  });

  it('the updater says what it knows: never "up to date" without a finished check', async () => {
    settingsViewSignal.value = view();
    const unchecked = { state: 'unchecked', mode: 'notify', current: '3.2.0', version: null, percent: null, error: null, checkedAt: null } as const;
    render(shell(<SettingsStage updateStatus={unchecked} />));
    expect(await screen.findByText('Not checked yet.')).toBeTruthy();
    expect(screen.queryByText(/up to date/i)).toBeNull();
  });
});

describe('Advanced', () => {
  const advanced = (over: Partial<SettingsView> = {}) => view({ mode: 'advanced', ...over });
  const row = (key: string) => document.querySelector(`[data-row="${key}"]`) as HTMLElement;
  const ceilingOverride = (stale: boolean): SettingsView => advanced({
    overrides: { count: 1, stale: stale ? 1 : 0, bySection: { pace: 1 } },
    params: GALLERY_SETTINGS_VIEW.params.map((p) => (p.key === 'pace.dailyCeiling'
      ? { ...p, value: 60, override: { requested: 60, setAt: 1, clamped: false, stale, basis: stale ? 52 : 65 } } : p)),
  });

  it('adds a Fine-tune block under the Easy sections; nothing above it moves', async () => {
    await mount(advanced());
    expect(screen.getAllByRole('group', { name: 'Fine-tune' }).length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole('radiogroup', { name: 'Growth pace' })).toBeTruthy();
    expect(row('pace.dailyVolume').textContent).toMatch(/Recommended 50 a day/);
  });

  it('a stepper press sends one override; the recommendation itself clears it', async () => {
    await mount(advanced());
    fireEvent.click(within(row('pace.hourlyCap')).getByRole('button', { name: 'Less: Most actions in an hour' }));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'override', key: 'pace.hourlyCap', value: 21 }]]));
  });

  it('a typed value commits on Enter; Esc reverts and sends nothing', async () => {
    await mount(advanced());
    const input = within(row('pace.dailyVolume')).getByRole('textbox', { name: 'Daily action target' }) as HTMLInputElement;
    fireEvent.input(input, { target: { value: '40' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(applyCalls()).toHaveLength(0);
    fireEvent.input(input, { target: { value: '40' } });
    fireEvent.blur(input);
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'override', key: 'pace.dailyVolume', value: 40 }]]));
  });

  it('an overridden row says "Set by you"; Use recommended sends clear-override', async () => {
    await mount(ceilingOverride(false));
    const r = row('pace.dailyCeiling');
    expect(within(r).getByText('Set by you')).toBeTruthy();
    fireEvent.click(within(r).getByText('Use recommended'));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'clear-override', key: 'pace.dailyCeiling' }]]));
  });

  it('a stale override says when it was set and what Epo recommends now', async () => {
    await mount(ceilingOverride(true));
    expect(row('pace.dailyCeiling').textContent).toMatch(/Set to 60 a day when Epo recommended 52 a day; it now recommends 65 a day/);
  });

  it('a save that moved a recommendation offers Use it or Keep yours, inline', async () => {
    await mount(ceilingOverride(false));
    bridge.stub('applySettings', (): SettingsSaveResult => ({
      kind: 'saved', view: ceilingOverride(false), adjustments: [], applies: [], inverse: [],
      conflicts: [{ key: 'pace.dailyCeiling', yours: 60, recommendedBefore: 65, recommendedNow: 39 }],
    }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Activity level' })).getByRole('radio', { name: /Light/ }));
    const note = await within(row('pace.dailyCeiling')).findByText(/You set Most actions in a day, including your own yourself \(60 a day\)/);
    fireEvent.click(within(note).getByText('Keep 60 a day'));
    expect(within(row('pace.dailyCeiling')).queryByText(/You set Most actions/)).toBeNull();
    expect(applyCalls()).toHaveLength(1);
  });

  it('Under the hood lists main’s catalog grouped by kind', async () => {
    bridge.stub('settingsBasis', { kind: 'ok', rows: GALLERY_BASIS });
    resetBasisCache();
    await mount(advanced({ capabilities: { ...GALLERY_SETTINGS_VIEW.capabilities, tempo: false } }));
    const hood = document.getElementById('settings-technical') as HTMLElement;
    expect(await within(hood).findByText('POLICY.CEILING_HEADROOM')).toBeTruthy();
    expect(within(hood).getByText(/Pointer and scroll motion/)).toBeTruthy();
    expect(within(hood).getByText('[220, 640] ms')).toBeTruthy();
  });

  it('Start over from the older version’s settings asks first, then sends only the migration op', async () => {
    await mount(advanced());
    fireEvent.click(within(row('startOver')).getByText('Start over'));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'migration', action: 'remigrate-from-v1' }]]));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('Diagnostics hosts the compatibility panel; Easy shows its one line, whose Details opens it', async () => {
    await mount();
    bridge.stub('applySettings', () => saved(advanced({ rev: 8 })));
    fireEvent.click(within(document.getElementById('settings-app') as HTMLElement).getByText('Details'));
    await waitFor(() => expect(applyCalls()).toEqual([[{ op: 'ui', mode: 'advanced' }]]));
    expect(await screen.findByRole('heading', { name: 'Diagnostics' })).toBeTruthy();
    expect(screen.getByText('Instagram compatibility')).toBeTruthy();
  });
});
