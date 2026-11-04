/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { useScrollSpy } from '@/renderer/settings/scroll-spy';

let emit: (seen: Array<[Element, boolean]>) => void;
let observed: Set<Element>;
const originalObserver = window.IntersectionObserver;

beforeEach(() => {
  observed = new Set();
  window.IntersectionObserver = jest.fn((callback: IntersectionObserverCallback) => {
    emit = (seen) => callback(seen.filter(([target]) => observed.has(target)).map(([target, isIntersecting]) =>
      ({ target, isIntersecting }) as IntersectionObserverEntry), {} as IntersectionObserver);
    return { observe: (target: Element) => observed.add(target), disconnect: () => observed.clear() };
  }) as unknown as typeof IntersectionObserver;
});
afterEach(() => { window.IntersectionObserver = originalObserver; });

function Page() {
  const ref = useRef<HTMLElement>(null);
  const active = useScrollSpy(ref, ['technical', 'diagnostics']);
  return (
    <div class="stage-view" data-testid="scroller">
      <output>{active}</output>
      <main ref={ref}>
        <section data-section="technical" data-testid="technical">Technical table</section>
        <section data-section="diagnostics" data-testid="diagnostics">
          Compatibility
          <div data-section="diagnostics" data-testid="nested-log">Log panel</div>
        </section>
      </main>
    </div>
  );
}

async function mount() {
  render(<Page />);
  await waitFor(() => expect(observed.size).toBeGreaterThan(0));
  return {
    root: screen.getByTestId('scroller'),
    technical: screen.getByTestId('technical'),
    diagnostics: screen.getByTestId('diagnostics'),
    nested: screen.getByTestId('nested-log'),
  };
}

it('tracks the visible section even when its nested log panel is below the observation band', async () => {
  const { technical, diagnostics, nested } = await mount();
  act(() => emit([[technical, false], [diagnostics, true], [nested, false]]));
  expect(screen.getByRole('status').textContent).toBe('diagnostics');
});

it('marks the final section at the scroll bottom, then resumes normal tracking when scrolling up', async () => {
  const { root, technical, diagnostics } = await mount();
  Object.defineProperties(root, { scrollHeight: { value: 1600 }, clientHeight: { value: 900 } });
  act(() => emit([[technical, true], [diagnostics, true]]));
  expect(screen.getByRole('status').textContent).toBe('technical');
  // The preceding long table can still intersect the top band when the short final section is fully visible.
  root.scrollTop = 700;
  fireEvent.scroll(root);
  expect(screen.getByRole('status').textContent).toBe('diagnostics');
  act(() => emit([[technical, true], [diagnostics, true]]));
  expect(screen.getByRole('status').textContent).toBe('diagnostics');
  root.scrollTop = 400;
  fireEvent.scroll(root);
  expect(screen.getByRole('status').textContent).toBe('technical');
});

it('does not jump to the final section when the page fits without scrolling', async () => {
  const { root, technical, diagnostics } = await mount();
  Object.defineProperties(root, { scrollHeight: { value: 900 }, clientHeight: { value: 900 } });
  act(() => emit([[technical, true], [diagnostics, true]]));
  fireEvent.scroll(root);
  expect(screen.getByRole('status').textContent).toBe('technical');
});
