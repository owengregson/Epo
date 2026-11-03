/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The starting-account field (spec §13): opening Settings checks nothing; the status line comes from the
 * facts; only an evidence-backed "doesn't exist" turns the field red; a check runs only on explicit intent.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { ShellContext, settingsFactsSignal, settingsViewSignal, statusSignal } from '@/renderer/app/shell-context';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { SeedStatus, SettingsFacts } from '@/shared/settings-facts';
import type { SettingsSaveResult } from '@/shared/settings-ops';
import type { SettingsView } from '@/shared/settings-view';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

let bridge: FakeBridge;
const shell = (node: ComponentChildren) => (
  <ShellContext.Provider value={{ confirm: jest.fn(async () => true), toast: jest.fn() }}>{node}</ShellContext.Provider>
);
const facts = (seed: SeedStatus): SettingsFacts => ({ ...GALLERY_SETTINGS_FACTS, seed });
const view = (over: Partial<SettingsView> = {}): SettingsView => ({ ...GALLERY_SETTINGS_VIEW, ...over });
const calls = (m: string) => bridge.calls.filter((c) => c[0] === m);
const field = () => screen.getByLabelText('Starting account') as HTMLInputElement;
const line = () => document.querySelector('.set-seed') as HTMLElement;

async function mount(f: SettingsFacts | null, v: SettingsView = view()): Promise<void> {
  settingsViewSignal.value = v;
  settingsFactsSignal.value = f;
  bridge.data.settingsView = v;
  render(shell(<SettingsStage />));
  await screen.findByRole('heading', { name: 'Who to follow' });
}

beforeEach(() => {
  bridge = installFakeBridge(DEFAULT_SETTINGS);
});

describe('the starting-account field', () => {
  it.each<[string, SettingsFacts | null]>([
    ['unseen', facts({ kind: 'unseen', handle: 'studio.lumen' })],
    ['gone', facts({ kind: 'gone', handle: 'studio.lumen', at: 1, evidence: 'page-text' })],
    ['no facts yet', null],
  ])('checks nothing when Settings opens (%s)', async (_name, f) => {
    await mount(f);
    expect(calls('checkSeed')).toHaveLength(0);
  });

  it('Esc puts the saved handle back and commits nothing', async () => {
    await mount(facts({ kind: 'unseen', handle: 'studio.lumen' }));
    fireEvent.focus(field());
    fireEvent.input(field(), { target: { value: 'typo' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    fireEvent.blur(field());
    expect(calls('applySettings')).toHaveLength(0);
    await waitFor(() => expect(field().value).toBe('studio.lumen'));
  });

  const now = Date.now();
  const cases: ReadonlyArray<[string, SeedStatus, RegExp, boolean]> = [
    ['seen', { kind: 'seen', handle: 'studio.lumen', pk: '1', currentUsername: 'studio.lumen', observedAt: now, followers: 12_400, isPrivate: false, followersVisible: true }, /@studio\.lumen · 12\.4k followers · public · checked just now/, false],
    ['seen private, hidden', { kind: 'seen', handle: 'studio.lumen', pk: '1', currentUsername: 'studio.lumen', observedAt: now, followers: null, isPrivate: true, followersVisible: false }, /is private\. Epo can only see its followers if you follow it/, false],
    ['unseen', { kind: 'unseen', handle: 'studio.lumen' }, /hasn’t checked @studio\.lumen yet/, false],
    ['checking', { kind: 'checking', handle: 'studio.lumen' }, /Checking @studio\.lumen/, false],
    ['queued (busy)', { kind: 'queued', handle: 'studio.lumen', why: 'engine' }, /Epo is busy right now/, false],
    ['queued (offline)', { kind: 'queued', handle: 'studio.lumen', why: 'offline' }, /You’re offline/, false],
    ['queued (signed out)', { kind: 'queued', handle: 'studio.lumen', why: 'signed-out' }, /after you sign in/, false],
    ['queued (reading)', { kind: 'queued', handle: 'studio.lumen', why: 'read-budget' }, /when today’s reading allows/, false],
    ['gone (page text)', { kind: 'gone', handle: 'studio.lumen', at: now, evidence: 'page-text' }, /shows @studio\.lumen as unavailable/, false],
    ['gone (profile absent)', { kind: 'gone', handle: 'studio.lumen', at: now, evidence: 'profile-absent' }, /Instagram says @studio\.lumen doesn’t exist/, true],
    ['loading', { kind: 'loading' }, /once it has opened your account/, false],
  ];
  it.each(cases)('%s maps to its own words, and only profile-absent is red', async (_name, seed, text, red) => {
    await mount(facts(seed));
    expect(line().textContent).toMatch(text);
    expect(field().getAttribute('aria-invalid')).toBe(String(red));
  });

  it('an unbuilt store is never a verdict', async () => {
    await mount({ ...GALLERY_SETTINGS_FACTS, built: false, protection: null, cleanup: null });
    expect(line().textContent).toMatch(/once it has opened your account/);
    expect(field().getAttribute('aria-invalid')).toBe('false');
  });

  it('Check now runs one check; a refusal it cannot read says so without turning red', async () => {
    await mount(facts({ kind: 'unseen', handle: 'studio.lumen' }));
    bridge.stub('checkSeed', { kind: 'unreadable', why: 'no-answer' });
    fireEvent.click(screen.getByText('Check now'));
    await waitFor(() => expect(line().textContent).toMatch(/Couldn’t check @studio\.lumen just now/));
    expect(calls('checkSeed')).toEqual([['checkSeed', 'studio.lumen']]);
    expect(field().getAttribute('aria-invalid')).toBe('false');
  });

  it('committing the same handle sends nothing and checks nothing', async () => {
    await mount(facts({ kind: 'unseen', handle: 'studio.lumen' }));
    fireEvent.focus(field());
    fireEvent.input(field(), { target: { value: '@studio.lumen ' } });
    fireEvent.blur(field());
    expect(calls('applySettings')).toHaveLength(0);
    expect(calls('checkSeed')).toHaveLength(0);
  });

  it('committing a different handle saves it, then checks it once the save landed', async () => {
    await mount(facts({ kind: 'unseen', handle: 'studio.lumen' }));
    const next = view({ rev: 8, seed: 'north.shore' });
    bridge.stub('applySettings', (): SettingsSaveResult => ({ kind: 'saved', view: next, adjustments: [], conflicts: [], applies: [], inverse: [] }));
    fireEvent.focus(field());
    fireEvent.input(field(), { target: { value: '@north.shore' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.blur(field());
    await waitFor(() => expect(calls('applySettings')).toEqual([['applySettings', [{ op: 'seed', handle: 'north.shore' }]]]));
    await waitFor(() => expect(calls('checkSeed')).toEqual([['checkSeed', 'north.shore']]));
  });

  it('a refused save reverts the field and never checks the unsaved handle', async () => {
    await mount(facts({ kind: 'unseen', handle: 'studio.lumen' }));
    bridge.stub('applySettings', (): SettingsSaveResult => ({ kind: 'not-saved', view: view(), detail: 'disk full' }));
    fireEvent.focus(field());
    fireEvent.input(field(), { target: { value: 'north.shore' } });
    fireEvent.blur(field());
    await screen.findByText('Not saved. Nothing was changed.');
    expect(field().value).toBe('studio.lumen');
    expect(calls('checkSeed')).toHaveLength(0);
  });

  it('while a chain is running, a new handle offers Start over or Save for later', async () => {
    statusSignal.value = idleStatus({ state: 'running', chainIndex: 0, currentTargetPk: '77' });
    await mount(facts({ kind: 'unseen', handle: 'studio.lumen' }));
    fireEvent.focus(field());
    fireEvent.input(field(), { target: { value: 'north.shore' } });
    fireEvent.blur(field());
    expect(calls('applySettings')).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByText('Start over from @north.shore'));
    });
    expect(calls('restartFromSeed')).toEqual([['restartFromSeed', 'north.shore']]);
    expect(calls('applySettings')).toHaveLength(0);
  });
});
