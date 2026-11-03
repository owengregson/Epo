/**
 * Shows a board as the whole page (the gallery stays mounted, hidden), in the
 * normal document flow so a full-page capture includes every frame. Gallery
 * only: nothing reaches this without the `?gallery=1` route.
 */
import { type JSX, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BoardPage } from '@/renderer/gallery/direction/Board';

export interface BoardNav {
  pick(id: string): void;
  close(): void;
}

let root: HTMLElement | null = null;

/** The page width without a vertical scrollbar; jsdom reports 0, so fall back to the window. */
function pageWidth(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

function BoardHost({ id, nav }: { id: string; nav: BoardNav }): JSX.Element {
  const [width, setWidth] = useState(pageWidth);
  useEffect(() => {
    const onResize = (): void => setWidth(pageWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    document.documentElement.scrollTop = 0;
  }, [id]);
  return <BoardPage id={id} width={width} onPick={nav.pick} onClose={nav.close} />;
}

export function showBoard(id: string, nav: BoardNav): void {
  if (root === null) {
    root = document.createElement('div');
    root.id = 'direction-board';
    document.body.appendChild(root);
  }
  document.documentElement.classList.add('db-open');
  render(<BoardHost id={id} nav={nav} />, root);
}

export function hideBoard(): void {
  if (typeof document === 'undefined') return;
  if (root !== null) {
    render(null, root);
    root.remove();
    root = null;
  }
  document.documentElement.classList.remove('db-open');
}
