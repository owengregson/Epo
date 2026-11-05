/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The live column's gallery scenarios (workplan SB step 1): every scenario renders the real column, each
 * posture scenario lands on its posture, and the Boost scenarios show their state.
 */
import { act, fireEvent, render, within } from '@testing-library/preact';
import { LIVE_SCENARIOS } from '@/renderer/gallery/fixtures-live';
import { Gallery, primeGallery } from '@/renderer/gallery/Gallery';

async function mountGallery(): Promise<void> {
  primeGallery();
  render(<Gallery />);
  await act(async () => {});
}

async function pick(label: string): Promise<void> {
  const rail = document.querySelector('.gallery-rail') as HTMLElement;
  await act(async () => {
    fireEvent.click(within(rail).getByText(label));
  });
  await act(async () => {});
}

const word = (): string => document.querySelector('.sidebar .sb-now__word')?.textContent ?? '';

const EXPECTED: Readonly<Record<string, string>> = {
  'live-working': 'Working', 'live-resting': 'Resting', 'live-pacing': 'Pacing', 'live-retrying': 'Retrying soon',
  'live-break': 'Taking a break', 'live-done': 'Done for today', 'live-done-late': 'Done for today',
  'live-done-light': 'Done for today', 'live-day-off': 'Day off', 'live-starting': 'Starting',
  'live-catching-up': 'Catching up', 'live-paused': 'Paused', 'live-stopped': 'Stopped', 'live-needs-seed': 'Get set up',
  'live-attention': 'Needs attention', 'live-sleeping': 'Sleeping', 'live-reconnecting': 'Reconnecting',
  'live-offline': 'Offline', 'live-signed-out': 'Signed out', 'live-data-unavailable': "Can't open data",
  'live-starting-up': 'Starting up', 'live-pruning': 'Pruning', 'live-prune-paused': 'Pruning paused',
};

describe('the live gallery', () => {
  it('every scenario renders the live column with a posture word', async () => {
    await mountGallery();
    for (const s of LIVE_SCENARIOS) {
      await pick(s.label);
      expect({ key: s.key, word: word().length > 0 }).toEqual({ key: s.key, word: true });
      if (EXPECTED[s.key] !== undefined) expect({ key: s.key, word: word() }).toEqual({ key: s.key, word: EXPECTED[s.key] });
    }
  });

  it('the late-start and light-day scenarios say why today is done', async () => {
    await mountGallery();
    await pick('Done · opened late');
    expect(document.querySelector('.sb-now__line')?.textContent).toBe('Today’s sessions had already passed when Epo opened.');
    await pick('Done · light day');
    expect(document.querySelector('.sb-now__line')?.textContent).toBe('Light day — no actions planned today.');
  });

  it('the Boost scenarios show the control, the band and the honest waits', async () => {
    await mountGallery();
    await pick('Boost · on');
    expect(document.querySelector('.sb-band')?.getAttribute('data-boost')).toBe('on');
    await pick('Boost · Epo stopped');
    expect(document.querySelector('.sb-band')?.getAttribute('data-boost')).toBe('paused');
    await pick('Boost · not ready');
    expect((document.querySelector('.sb-btn--boost') as HTMLButtonElement).disabled).toBe(true);
    await pick('Boost · ready');
    expect((document.querySelector('.sb-btn--boost') as HTMLButtonElement).disabled).toBe(false);
    await pick('Boost · nothing to shift');
    expect(document.querySelector('.sb-boost')?.getAttribute('data-tip')).toBe(
      "Today is already at Epo's fullest day, and Epo is already working.",
    );
  });

  it('the first run shows Get started, and the away feed its divider', async () => {
    await mountGallery();
    await pick('First run');
    expect(document.querySelector('.sb-start')).not.toBeNull();
    await pick('Away feed');
    expect(document.querySelector('.sb-feed__divider')?.textContent).toMatch(/^Since you left · /);
  });
});
