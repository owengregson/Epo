/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The dev gallery (ADR 1006) is a review surface, not a test bed — but it
 * mounts the console column and every stage page against fixtures, so it rots
 * the moment a page's props or a Settings knob changes. This smoke test is the
 * tripwire: it proves the route mounts with no main process behind it, and that
 * picking a scenario actually moves the console — which is also a check that
 * the cards are still reading the shell's signals rather than props someone
 * re-introduced.
 */
import { act, fireEvent, render, within } from '@testing-library/preact';
import { pruneSignal, statusSignal } from '@/renderer/app/shell-context';
import { SCENARIOS } from '@/renderer/gallery/fixtures';
import { Gallery, primeGallery } from '@/renderer/gallery/Gallery';

/** The picker rail — scoped, because the pages carry some of the same labels. */
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
    expect(document.querySelector('.sidebar [data-zone="now"]')).not.toBeNull();
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

  it('mounts every stage page beside the console column', async () => {
    await mountGallery();
    expect(document.querySelector('[data-stage="people"]')).not.toBeNull();
    for (const label of ['Settings', 'Prune']) {
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

test('the gallery rail can leave the layout without changing the chosen page or scenario', async () => {
  await mountGallery();
  await act(async () => { fireEvent.click(rail().getByText('Prune')); });
  const picker = document.querySelector('.gallery-rail') as HTMLElement;
  await act(async () => { fireEvent.click(rail().getByText('Hide gallery controls')); });
  expect(picker.hidden).toBe(true);
  expect(document.querySelector('[data-stage="prune"]')).not.toBeNull();
  await act(async () => { fireEvent.click(within(document.body).getByText('Show gallery controls')); });
  expect(picker.hidden).toBe(false);
  expect(document.querySelector('[data-stage="prune"]')).not.toBeNull();
});


test('the gallery Prune budget follows the selected plan, including a day off', async () => {
  await mountGallery();
  for (const label of ['Settings · Easy', 'Day off', 'Working · next step']) {
    await act(async () => { fireEvent.click(rail().getByText(label)); });
    const allocation = statusSignal.value?.plan?.kinds.unfollow;
    expect(allocation).toBeDefined();
    expect(pruneSignal.value?.dailyLimit).toBe(allocation?.planned);
    expect(pruneSignal.value?.dailyDone).toBe(allocation?.done);
  }
});
