/**
 * One direction board: a bar to move between boards, a header saying what to
 * judge, and the frames placed by `packFrames` (absolute, so the test reads
 * the same rects the eye sees). The boards read the app's own tokens.
 */
import { type JSX } from 'preact';
import { BOARD_PAD, packFrames } from '@/renderer/gallery/direction/layout';
import { BOARDS, type BoardSpec } from '@/renderer/gallery/direction/registry';

/** The board header's fixed height (title and a two-line introduction). */
const HEAD_H = 136;

export interface BoardPageProps {
  id: string;
  /** Canvas width: the window width the board is judged at. */
  width: number;
  onPick?: (id: string) => void;
  onClose?: () => void;
}

export function BoardPage({ id, width, onPick, onClose }: BoardPageProps): JSX.Element {
  const board = BOARDS.find((b) => b.id === id) ?? (BOARDS[0] as BoardSpec);
  const frames = board.frames(width);
  const rects = new Map(packFrames(frames, width, HEAD_H).map((r) => [r.key, r]));
  const height = Math.max(HEAD_H, ...[...rects.values()].map((r) => r.y + r.h)) + BOARD_PAD;
  return (
    <div class="db" data-board={board.id}>
      <nav class="db-bar" aria-label="Direction boards">
        <span class="db-bar__title">Direction boards</span>
        <span class="db-bar__chips">
          {BOARDS.map((b) => (
            <button key={b.id} type="button" class={b.id === board.id ? 'is-on' : undefined} onClick={() => onPick?.(b.id)}>
              {b.chip}
            </button>
          ))}
        </span>
        <button type="button" class="db-bar__close" onClick={() => onClose?.()}>
          Back to the gallery
        </button>
      </nav>
      <div class="db-canvas" style={`width:${width}px;height:${height}px`}>
        <header class="db-head" style={`height:${HEAD_H}px`}>
          <h1>{board.title}</h1>
          <p>{board.intro}</p>
        </header>
        {frames.map((f) => {
          const r = rects.get(f.key);
          if (!r) return null;
          return (
            <figure
              key={f.key}
              class={f.bleed ? 'db-frame is-bleed' : 'db-frame'}
              data-frame={f.key}
              style={`left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`}
            >
              <figcaption>
                <b>{f.title}</b>
                <span>{f.note}</span>
              </figcaption>
              <div class="db-frame__body" style={`height:${f.h}px`}>
                {f.render()}
              </div>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
