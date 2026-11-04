/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { settingsViewSignal } from '@/renderer/app/shell-context';
import { NEW_LOOK_STEPS, NEW_LOOK_VERSION } from '@/renderer/tour/steps';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { installFakeBridge } from '../kit/render-bridge';

const previousInstall = () => {
  const bridge = installFakeBridge({ ...DEFAULT_SETTINGS, seed: 'source', tourCompletedAt: 1 });
  bridge.data.settingsView = { ...bridge.data.settingsView, app: { tourCompletedAt: 1, tourVersionSeen: null } };
  return bridge;
};

test('an existing install offers the short tour once and persists its version through v2', async () => {
  const bridge = previousInstall();
  const app = render(<App />);
  await waitFor(() => expect(app.getByText('Epo has a new look.')).toBeTruthy());
  await waitFor(() => expect(bridge.data.settingsView.app.tourVersionSeen).toBe(NEW_LOOK_VERSION));
  await act(async () => { fireEvent.click(app.getByText('Take the tour')); });
  await waitFor(() => expect(document.querySelector('.tour-kicker')?.textContent).toContain(`1 / ${NEW_LOOK_STEPS.length}`));
  expect(document.querySelector('.tour-t')?.textContent).toBe(NEW_LOOK_STEPS[0]?.title);
  await act(async () => { fireEvent.click(app.getByLabelText('Skip the tour')); });
  await waitFor(() => expect(document.querySelector('.tour')).toBeNull());
  expect(bridge.calls.some((c) => c[0] === 'updateSettings')).toBe(false);
  expect(bridge.data.settingsView.app.tourCompletedAt).toBeGreaterThan(1);
  expect(bridge.calls).toContainEqual(['setTourHold', false]);
  app.unmount();
  render(<App />);
  await act(async () => {});
  expect(document.body.textContent).not.toContain('Epo has a new look.');
});

test('a refused new-look acknowledgment surfaces the failure and leaves the saved version untouched', async () => {
  const bridge = previousInstall();
  bridge.stub('applySettings', { kind: 'not-saved', view: bridge.data.settingsView, detail: 'disk full' });
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain('couldn’t save your tour progress'));
  expect(settingsViewSignal.value?.app.tourVersionSeen).toBeNull();
});

test('a rejected completion write is visible and releases the tour hold', async () => {
  const bridge = installFakeBridge({ ...DEFAULT_SETTINGS, tourCompletedAt: null });
  const app = render(<App />);
  await waitFor(() => expect(app.getByLabelText('Skip the tour')).toBeTruthy());
  bridge.failNext('applySettings', 'disk closed');
  await act(async () => { fireEvent.click(app.getByLabelText('Skip the tour')); });
  await waitFor(() => expect(document.body.textContent).toContain('couldn’t save your tour progress'));
  expect(bridge.data.settingsView.app.tourCompletedAt).toBeNull();
  expect(bridge.calls).toContainEqual(['setTourHold', false]);
});
