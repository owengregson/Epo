/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * Every tour step points at something that is on screen when the step shows.
 * The tour walks the real shell (each step drives the stage first), so a step
 * whose `data-tour` anchor went away with a deleted card would open a card that
 * waits forever for its target. This walks the whole tour on the mounted app.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { TOUR_STEPS } from '@/renderer/tour/steps';
import { installFakeBridge } from '../kit/render-bridge';

/** A first launch: the tour has never run, so it opens by itself. */
const FIRST_RUN = { seed: 'someone', app: { tourCompletedAt: null } };

beforeEach(() => {
  installFakeBridge(FIRST_RUN);
  // jsdom has no IntersectionObserver; the settings projection chart observes its own visibility.
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

/** The anchor a step spotlights, when it is in the document and not inside a hidden subtree. */
function anchorFor(target: string): Element | null {
  const el = document.querySelector(`[data-tour~="${target}"]`);
  return el !== null && el.closest('[hidden]') === null ? el : null;
}

/** The step the open tour shows, read from its "Intro tour · i / n" kicker. */
function shownStep(): (typeof TOUR_STEPS)[number] | undefined {
  const kicker = document.querySelector('.tour-kicker')?.textContent ?? '';
  const i = Number(/(\d+)\s*\//.exec(kicker)?.[1] ?? '0') - 1;
  return TOUR_STEPS[i];
}

describe('the intro tour', () => {
  it('resolves every step’s anchor on the live shell', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('.tour')).not.toBeNull(), { timeout: 3000 });

    const seen = new Set<string>();
    const unresolved: string[] = [];
    for (let guard = 0; guard < TOUR_STEPS.length * 3 && document.querySelector('.tour') !== null; guard++) {
      await act(async () => {});
      const step = shownStep();
      if (step === undefined) break;
      seen.add(step.id);
      if (step.target !== undefined && anchorFor(step.target) === null) unresolved.push(`${step.id} → ${step.target}`);
      if (step.target === 'seed') expect(anchorFor('seed')?.getAttribute('data-row')).toBe('seed');
      await act(async () => {
        fireEvent.click(document.querySelector('.tour-next') as HTMLButtonElement);
      });
    }
    expect(unresolved).toEqual([]);
    expect([...seen]).toEqual(TOUR_STEPS.map((s) => s.id));
    expect(document.querySelector('.tour')).toBeNull();
  });
});
