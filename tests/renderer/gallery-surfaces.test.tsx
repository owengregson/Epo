/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { act, fireEvent, render, within } from '@testing-library/preact';
import { modalSignal, stageSignal } from '@/renderer/app/shell-context';
import { galleryGraph } from '@/renderer/gallery/fixtures';
import { Gallery, primeGallery } from '@/renderer/gallery/Gallery';
import { GRAPH_NODE_STATUSES } from '@/types';

const rail = (): ReturnType<typeof within> => within(document.querySelector('.gallery-rail') as HTMLElement);
const choose = async (name: string): Promise<void> => {
  await act(async () => { fireEvent.click(rail().getByRole('button', { name, exact: true })); });
  await act(async () => {});
};
async function mount(): Promise<ReturnType<typeof render>> {
  primeGallery();
  const view = render(<Gallery />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  // Browser QA draws the real canvas; jsdom cannot supply a 2D rendering context.
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => jest.restoreAllMocks());

test('the real StageBar selects pages and keeps the shared stage signal in sync', async () => {
  const view = await mount();
  const pages = within(view.getByRole('radiogroup', { name: 'Pages' }));
  await act(async () => { fireEvent.click(pages.getByRole('radio', { name: 'Graph' })); });
  expect(stageSignal.value).toBe('graph');
  expect(document.querySelector('.stage-view.active[data-stage="graph"] canvas')).not.toBeNull();
  expect(pages.getByRole('radio', { name: 'Graph' }).getAttribute('aria-checked')).toBe('true');
  await act(async () => { fireEvent.keyDown(pages.getByRole('radio', { name: 'Graph' }), { key: 'ArrowRight' }); });
  expect(stageSignal.value).toBe('prune');
  expect(document.activeElement).toBe(pages.getByRole('radio', { name: 'Prune' }));
  await choose('Live placeholder');
  expect(stageSignal.value).toBe('tab');
  expect(pages.getByRole('radio', { name: 'Live' }).getAttribute('aria-checked')).toBe('true');
});

test('Graph uses real pull/filter/retry UI with isolated synthetic states', async () => {
  await mount();
  await choose('Graph empty');
  expect(document.querySelector('.graph-empty')?.textContent).toMatch(/graph is empty/);
  expect(document.querySelector('.graph-legend__total')?.textContent).toBe('0');
  await choose('Graph populated');
  expect(document.querySelector('.graph-empty')).toBeNull();
  const filter = document.querySelector('.gleg-row') as HTMLButtonElement;
  await act(async () => { fireEvent.click(filter); });
  expect(filter.classList.contains('off')).toBe(true);
  await choose('Graph unavailable');
  expect(document.querySelector('.graph-empty')?.textContent).toMatch(/can’t read the graph/);
  expect(within(document.querySelector('.graph-stage') as HTMLElement).getByRole('button', { name: 'Try again' })).toBeTruthy();
  await choose('Working · next step');
  expect(document.querySelector('.graph-empty')).toBeNull();
  expect(document.querySelector('.gleg-row.off')).toBeNull();
  expect(await window.epo.graphSnapshot()).not.toEqual({ unavailable: true });
});

test('real confirmation choices stay open until an explicit confirm or dismiss', async () => {
  await mount();
  await choose('Open confirmation');
  const dialog = within(document.querySelector('.scrim.open .modal') as HTMLElement);
  expect(modalSignal.value).toBe(true);
  expect(dialog.getByText('Enable gradual cleanup?')).toBeTruthy();
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Keep it off' })); });
  expect(document.querySelector('.scrim.open')).toBeNull();
  expect(modalSignal.value).toBe(false);
  await choose('Open destructive confirmation');
  expect(document.querySelector('.scrim.open .confirm-danger')?.textContent).toBe('Stop run');
  await act(async () => { fireEvent.click(within(document.querySelector('.scrim.open') as HTMLElement).getByRole('button', { name: 'Stop run' })); });
  expect(document.querySelector('.scrim.open')).toBeNull();
});

test('a page confirmation uses the same host instead of silently auto-accepting', async () => {
  await mount();
  await choose('Prune — running');
  await choose('Prune');
  const page = within(document.querySelector('.prune-page') as HTMLElement);
  await act(async () => { fireEvent.click(page.getByRole('button', { name: 'Stop prune' })); });
  expect(document.querySelector('.scrim.open .modal-t')?.textContent).toBe('Stop the prune run?');
  await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
  expect(document.querySelector('.scrim.open')).toBeNull();
});

test('the accessible tour launcher walks real pages and restores its starting page', async () => {
  await mount();
  await choose('Prune');
  await choose('Start intro tour');
  expect(document.querySelector('[aria-label="Intro tour"]')).not.toBeNull();
  expect(stageSignal.value).toBe('graph');
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { fireEvent.keyDown(document, { key: 'ArrowRight' }); });
  }
  expect(stageSignal.value).toBe('settings');
  expect(document.querySelector('.stage-view.active [data-tour~="seed"]')).not.toBeNull();
  await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
  expect(document.querySelector('[aria-label="Intro tour"]')).toBeNull();
  expect(stageSignal.value).toBe('prune');
  expect(modalSignal.value).toBe(false);
});

test('review controls follow the Page marker so scenario enumeration remains unambiguous', async () => {
  await mount();
  const headings = [...document.querySelectorAll('.gallery-rail__h')];
  const page = headings.find((element) => element.textContent === 'Page');
  expect(page).toBeDefined();
  for (const name of ['Graph empty', 'Graph populated', 'Start intro tour', 'Open confirmation']) {
    expect(page!.compareDocumentPosition(rail().getByRole('button', { name })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

test('graph fixtures have consistent identities, columns, counts and cluster membership', () => {
  for (const state of ['populated', 'empty'] as const) {
    const graph = galleryGraph(state);
    if (graph === null || 'unavailable' in graph) throw new Error('expected snapshot');
    const n = graph.pks.length;
    expect(new Set(graph.pks).size).toBe(n);
    for (const column of [graph.usernames, graph.statuses, graph.progress, graph.hubIndex, graph.followers]) expect(column).toHaveLength(n);
    for (const [index, status] of GRAPH_NODE_STATUSES.entries()) {
      expect(graph.counts[status]).toBe([...graph.statuses].filter((value) => value === index).length);
    }
    expect(graph.hubs.reduce((sum, hub) => sum + hub.memberCount, 0)).toBe(n);
    for (const [index, hub] of graph.hubs.entries()) {
      expect(hub.memberCount).toBe([...graph.hubIndex].filter((value) => value === index).length);
      expect(graph.pks).not.toContain(hub.pk);
    }
  }
});
