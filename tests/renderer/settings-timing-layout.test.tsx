/** @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { ShellContext, settingsViewSignal } from '@/renderer/app/shell-context';
import { GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { TIMING_COPY } from '@/renderer/settings/copy/advanced';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import { installFakeBridge } from '../kit/render-bridge';

describe('compact timing controls', () => {
  it('shares the constraint once while each multiplier retains its label, range, and commit behavior', async () => {
    const bridge = installFakeBridge();
    const view = { ...GALLERY_SETTINGS_VIEW, mode: 'advanced' as const };
    settingsViewSignal.value = view;
    bridge.data.settingsView = view;
    bridge.stub('applySettings', () => ({ kind: 'saved', view: { ...view, rev: view.rev + 1 }, adjustments: [], conflicts: [], applies: [], inverse: [] }));
    render(
      <ShellContext.Provider value={{ confirm: jest.fn(async () => true), toast: jest.fn() }}>
        <SettingsStage />
      </ShellContext.Provider>,
    );
    await screen.findByRole('heading', { name: 'Timing' });
    expect(screen.getAllByText(TIMING_COPY.guidance)).toHaveLength(1);
    const input = screen.getByRole('textbox', {
      name: 'Time spent on each profile',
      description: /The plan’s own pace is ×1.*Changes update today’s remaining plan.*Safe range/,
    });
    const row = input.closest('[data-row="tempo.dwell.visit"]') as HTMLElement;
    expect(within(row).getByText('Recommended ×1.0')).toBeTruthy();
    expect(row.textContent).not.toContain('You can only make it longer.');
    fireEvent.click(within(row).getByRole('button', { name: 'More: Time spent on each profile' }));
    await waitFor(() => expect(bridge.calls.filter((call) => call[0] === 'applySettings').map((call) => call[1])).toEqual([
      [{ op: 'override', key: 'tempo.dwell.visit', value: 1.1 }],
    ]));
  });
});
