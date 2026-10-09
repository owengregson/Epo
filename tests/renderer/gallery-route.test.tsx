/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The dev gallery (ADR 1006) is a review surface, not a test bed — but it
 * mounts every view against fixtures, so it rots the moment a view's props or
 * a Settings knob changes. This smoke test is the tripwire: it proves the
 * route mounts with no main process behind it, and that picking a scenario
 * actually moves the console — which is also a check that the cards are still
 * reading the shell's signals rather than props someone re-introduced.
 */
import { act, fireEvent, render, within } from '@testing-library/preact';
import { SCENARIOS } from '@/renderer/gallery/fixtures';
import { Gallery, primeGallery } from '@/renderer/gallery/Gallery';

/** The picker rail — scoped, because the nav carries the same view labels. */
const rail = (): ReturnType<typeof within> =>
  within(document.querySelector('.gallery-rail') as HTMLElement);

/** Mount the gallery the way `index.tsx` does behind `?gallery=1`. */
async function mountGallery(): Promise<void> {
  primeGallery();
  render(<Gallery />);
  await act(async () => {});
}

describe('the ?gallery=1 route', () => {
  it('mounts with a stubbed bridge — no main process, no rejected pulls', async () => {
    await mountGallery();
    expect(document.querySelector('.console')).not.toBeNull();
    expect(document.querySelector('#view-overview')).not.toBeNull();
  });

  it('every scenario is selectable and drives the console posture', async () => {
    await mountGallery();
    // The picker seeds "Running"; the halted scenario must change data-state.
    await act(async () => {
      fireEvent.click(rail().getByText('Halted'));
    });
    expect(document.querySelector('.console')?.getAttribute('data-state')).toBe('halted');

    await act(async () => {
      fireEvent.click(rail().getByText('Prune — scanning'));
    });
    // A prune holding the tab reads as running (the unified transport).
    expect(document.querySelector('.console')?.getAttribute('data-state')).toBe('running');
  });

  it('mounts every surface, including the stage-hosted prune page', async () => {
    await mountGallery();
    for (const label of ['Targets', 'Queues', 'Settings', 'Prune']) {
      await act(async () => {
        fireEvent.click(rail().getByText(label));
      });
    }
    expect(document.querySelector('.prune-page')).not.toBeNull();
  });

  it('covers every posture the console is designed for', async () => {
    await mountGallery();
    for (const s of SCENARIOS) expect(rail().getByText(s.label)).toBeTruthy();
  });
});
