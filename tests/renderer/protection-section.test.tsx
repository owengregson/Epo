/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * Protection (spec §7.8): add through the store-only typeahead, paste a list, remove with Undo (main's own
 * inverse), no "remove all", live word counts, and "—" (never 0) while the store has not answered.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { ShellContext, settingsFactsSignal, settingsViewSignal } from '@/renderer/app/shell-context';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { parseHandles } from '@/renderer/settings/fields/PeopleList';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import type { SettingsFacts } from '@/shared/settings-facts';
import type { SettingsOp, SettingsSaveResult } from '@/shared/settings-ops';
import type { SettingsView } from '@/shared/settings-view';
import { type FakeBridge, installFakeBridge } from '../kit/render-bridge';

let bridge: FakeBridge;
const shell = (node: ComponentChildren) => (
  <ShellContext.Provider value={{ confirm: jest.fn(async () => true), toast: jest.fn() }}>{node}</ShellContext.Provider>
);
const view = (over: Partial<SettingsView> = {}): SettingsView => ({ ...GALLERY_SETTINGS_VIEW, ...over });
const saved = (v: SettingsView, inverse: SettingsOp[] = []): SettingsSaveResult =>
  ({ kind: 'saved', view: v, adjustments: [], conflicts: [], applies: [], inverse });
const applied = () => bridge.calls.filter((c) => c[0] === 'applySettings').map((c) => c[1]);
const section = () => document.getElementById('settings-protection') as HTMLElement;

async function mount(f: SettingsFacts | null = GALLERY_SETTINGS_FACTS, v: SettingsView = view()): Promise<void> {
  settingsViewSignal.value = v;
  settingsFactsSignal.value = f;
  bridge.data.settingsView = v;
  render(shell(<SettingsStage />));
  await screen.findByRole('heading', { name: 'Protection' });
}

beforeEach(() => {
  bridge = installFakeBridge();
});

describe('the Protection section', () => {
  it('adds a suggested account you follow, with its pk, from the store-only typeahead', async () => {
    await mount();
    bridge.stub('suggestAccounts', {
      kind: 'ok',
      rows: [{ pk: '501', username: 'mara.lens', youFollow: true, followsYou: true, isVerified: false, followers: 900, protected: false }],
    });
    const box = within(section()).getByRole('combobox', { name: 'Add @username' });
    fireEvent.input(box, { target: { value: 'mar' } });
    await within(section()).findByRole('option', { name: /@mara\.lens/ });
    expect(bridge.calls.filter((c) => c[0] === 'suggestAccounts')).toEqual([['suggestAccounts', 'mar', 'following']]);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(applied()).toEqual([[{ op: 'protect-add', entries: [{ username: 'mara.lens', pk: '501' }], source: 'you' }]]));
  });

  it('adds a typed handle when nothing is suggested', async () => {
    await mount();
    const box = within(section()).getByRole('combobox', { name: 'Add @username' });
    fireEvent.input(box, { target: { value: '@New.Friend' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(applied()).toEqual([[{ op: 'protect-add', entries: [{ username: 'new.friend' }], source: 'you' }]]));
  });

  it('pastes a list in one add, skipping accounts already protected', async () => {
    await mount();
    fireEvent.click(within(section()).getByText('Paste a list'));
    fireEvent.input(within(section()).getByLabelText(/one per line/), { target: { value: '@one.a, two_b\ntheo.park  one.a' } });
    fireEvent.click(within(section()).getByText('Add them'));
    await waitFor(() =>
      expect(applied()).toEqual([[{ op: 'protect-add', entries: [{ username: 'one.a' }, { username: 'two_b' }], source: 'you' }]]),
    );
    expect(parseHandles(' a;b ,, @a ')).toEqual(['a', 'b']);
  });

  it('removing shows Undo, which sends main’s own inverse; there is no remove-all', async () => {
    await mount();
    const restore: SettingsOp[] = [{ op: 'protect-restore', accounts: [GALLERY_SETTINGS_VIEW.protection.accounts[0]], words: [] }];
    const after = view({ rev: 8, protection: { ...GALLERY_SETTINGS_VIEW.protection, accounts: GALLERY_SETTINGS_VIEW.protection.accounts.slice(1) } });
    bridge.stub('applySettings', () => saved(after, restore));
    fireEvent.click(within(section()).getByRole('button', { name: 'Remove @theo.park' }));
    await waitFor(() => expect(applied()).toEqual([[{ op: 'protect-remove', match: { pk: '2001' } }]]));
    const undo = await within(section()).findByText('Removed @theo.park from Protection.');
    fireEvent.click(within(undo).getByText('Undo'));
    await waitFor(() => expect(applied()[1]).toEqual(restore));
    expect(within(section()).queryByRole('button', { name: /remove all/i })).toBeNull();
    expect(within(section()).queryByText(/remove all/i)).toBeNull();
  });

  it('shows each entry’s standing and each word’s live count', async () => {
    await mount();
    expect(within(section()).getByText('You follow · Follows you')).toBeTruthy();
    expect(within(section()).getByText('Renamed from @theo.parks')).toBeTruthy();
    expect(within(section()).getByText('Not seen yet — check the spelling')).toBeTruthy();
    expect(within(section()).getByText('Not a valid username')).toBeTruthy();
    expect(within(section()).getByText('96 people')).toBeTruthy();
    const box = section().querySelector('.set-summary-box') as HTMLElement;
    expect([...box.querySelectorAll('.nt')].map((n) => n.getAttribute('aria-label'))).toEqual(['214', '1,830', '12', '96']);
  });

  it('shows "—" with a reason, never 0, until the store answers', async () => {
    await mount(null);
    expect(section().textContent).toMatch(/Protecting — of the — accounts Epo has seen you follow · Kept so far: — · Bios not read yet: —/);
    expect(within(section()).getByText('The counts appear once Epo has opened your account.')).toBeTruthy();
    expect(within(section()).getAllByText('—').length).toBeGreaterThan(0);
    expect(section().textContent).not.toMatch(/Protecting 0/);
  });

  it('adds and removes keywords with one op each', async () => {
    await mount();
    fireEvent.input(within(section()).getByLabelText('Add a word or phrase'), { target: { value: 'coach, vegan' } });
    fireEvent.keyDown(within(section()).getByLabelText('Add a word or phrase'), { key: 'Enter' });
    await waitFor(() => expect(applied()).toEqual([[{ op: 'word-add', texts: ['coach', 'vegan'] }]]));
    fireEvent.click(within(section()).getByRole('button', { name: 'Remove “family”' }));
    await waitFor(() => expect(applied()[1]).toEqual([{ op: 'word-remove', text: 'family' }]));
  });
});
