/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * Settings search (spec §6.5): every older-version setting name finds the row that holds it now (or the
 * row that says why it is gone), the everyday words find their rows, every target exists on the page, and
 * in Easy a hit only Advanced has says so and opens Advanced.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { ShellContext, settingsFactsSignal, settingsViewSignal, stageSignal } from '@/renderer/app/shell-context';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import { searchSettings } from '@/renderer/settings/search';
import { ROWS, SYNONYMS, V1_HOMES, V1_RETIRED } from '@/renderer/settings/search-index';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { SETTINGS_KEYS } from '@/settings/v1/settings-v1';
import type { SettingsSaveResult } from '@/shared/settings-ops';
import type { SettingsView } from '@/shared/settings-view';
import { type FakeBridge, installFakeBridge } from '../kit/render-bridge';

let bridge: FakeBridge;
const view = (over: Partial<SettingsView> = {}): SettingsView => ({ ...GALLERY_SETTINGS_VIEW, ...over });
const shell = (node: ComponentChildren) => (
  <ShellContext.Provider value={{ confirm: jest.fn(async () => true), toast: jest.fn() }}>{node}</ShellContext.Provider>
);

async function mount(v: SettingsView): Promise<void> {
  settingsViewSignal.value = v;
  settingsFactsSignal.value = GALLERY_SETTINGS_FACTS;
  stageSignal.value = 'settings';
  render(shell(<SettingsStage />));
  await screen.findByRole('heading', { name: 'Settings', level: 1 });
}

beforeEach(() => {
  bridge = installFakeBridge(DEFAULT_SETTINGS);
  Element.prototype.scrollIntoView = jest.fn();
});

describe('Settings search', () => {
  it('maps every older-version setting to a row, or documents why it is gone', () => {
    for (const key of SETTINGS_KEYS) {
      const home = V1_HOMES[key];
      const gone = V1_RETIRED[key];
      expect([key, home !== undefined || gone !== undefined]).toEqual([key, true]);
      if (gone !== undefined) expect(gone.why.length).toBeGreaterThan(10);
    }
    for (const [name, hits] of SETTINGS_KEYS.map((k) => [k, searchSettings(k, GALLERY_SETTINGS_VIEW, 'advanced')] as const)) {
      expect([name, hits.length > 0]).toEqual([name, true]);
    }
  });

  it.each([
    ['whitelist', 'protection.people'], ['bio keep-words', 'protection.words'], ['persona', 'pace.cards'],
    ['dry run', 'practice'], ['seed', 'seed'], ['active hours', 'quietHours'], ['pacing', 'pace.cards'],
    ['jitter', 'sessions.gapTypical'], ['Mornings', 'schedule.shape'], ['verified', 'protection.verified'],
  ])('“%s” finds %s first', (q, row) => {
    expect(searchSettings(q, GALLERY_SETTINGS_VIEW, 'advanced')[0]?.target.row).toBe(row);
  });

  it('every search target exists on the Advanced page', async () => {
    await mount(view({ mode: 'advanced' }));
    const targets = [...ROWS, ...Object.values(V1_HOMES), ...Object.values(V1_RETIRED), ...SYNONYMS.map(([, t]) => t)];
    const missing = targets.filter((t) => t.row !== undefined && document.querySelector(`[data-row="${t.row}"]`) === null).map((t) => t.row);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('says what an older name became', () => {
    const [hit] = searchSettings('jitterPercent', GALLERY_SETTINGS_VIEW, 'advanced');
    expect(hit?.note).toMatch(/Steady intervals is retired/);
  });

  it('in Easy, an Advanced-only hit says so and opens Advanced on pick', async () => {
    await mount(view());
    bridge.stub('applySettings', (): SettingsSaveResult => ({
      kind: 'saved', view: view({ rev: 8, mode: 'advanced' }), adjustments: [], conflicts: [], applies: [], inverse: [],
    }));
    const box = screen.getByRole('combobox', { name: 'Search settings' });
    fireEvent.input(box, { target: { value: 'refill' } });
    const hit = await screen.findByRole('option', { name: /In Advanced → Finding new people · Show/ });
    fireEvent.mouseDown(hit);
    await waitFor(() => expect(bridge.calls.filter((c) => c[0] === 'applySettings').map((c) => c[1])).toEqual([[{ op: 'ui', mode: 'advanced' }]]));
    await screen.findByRole('heading', { name: 'Finding new people' });
  });

  it('“/” focuses search, Enter opens the first hit, Esc clears', async () => {
    await mount(view());
    fireEvent.keyDown(document.body, { key: '/' });
    const box = screen.getByRole('combobox', { name: 'Search settings' }) as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    fireEvent.input(box, { target: { value: 'quiet' } });
    expect(within(screen.getByRole('listbox', { name: 'Search settings' })).getAllByRole('option')[0]?.textContent).toMatch(/Quiet hours/);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    fireEvent.input(box, { target: { value: 'quiet' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(box.value).toBe('');
  });

  it('nothing found says so', () => {
    expect(searchSettings('zzzz', GALLERY_SETTINGS_VIEW, 'easy')).toEqual([]);
  });
});
