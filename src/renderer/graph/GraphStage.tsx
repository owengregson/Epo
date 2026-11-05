/**
 * The Graph stage — the canvas filling the stage body (right of the console,
 * under the stage bar) while the Graph tab is selected. It stays MOUNTED in
 * both stage modes (the native Instagram view simply covers it), so the
 * camera and the layout's slot maps survive round-trips through the tab.
 *
 * This file is the Preact shell only: the legend, the tooltip bubble and its
 * measure-then-clamp placement, the empty states, and the three effects that
 * feed the canvas. The frame itself — the perf model and every animation,
 * including the reduced-motion collapse — lives in `graph/world.ts`; the DOM
 * plumbing that drives it (backing-store sizing, the dpr and reduced-motion
 * media queries, the rAF gate, pointer wiring) in `graph/useGraphCanvas.ts`.
 */
import { type JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LEGEND_LABELS, legendColor, legendColorWashed, STATUS_COLORS } from '@/renderer/graph/palette';
import { useGraphCanvas } from '@/renderer/graph/useGraphCanvas';
import type { GraphBoard } from '@/renderer/hooks/useGraphBoard';
import { clampInto } from '@/renderer/lib/anchor';
import { commas } from '@/renderer/lib/format';
import { Button } from '@/renderer/ui/Button';
import { Icon } from '@/renderer/ui/Icon';
import { GRAPH_NODE_STATUSES, type GraphNodeStatus } from '@/types';

/** A legend swatch: flat for plain statuses, washed→full ramp for timed ones. */
const swatchStyle = (status: GraphNodeStatus): string =>
  STATUS_COLORS[status].timed
    ? `background:linear-gradient(90deg, ${legendColorWashed(status)}, ${legendColor(status)})`
    : `background:${legendColor(status)}`;

export interface GraphStageProps {
  board: GraphBoard;
  /** True while the Graph stage tab is selected (the native tab is hidden). */
  active: boolean;
}

export function GraphStage({ board, active }: GraphStageProps): JSX.Element {
  const { hostRef, canvasRef, world, tip, dragCursor, redraw, fit, repick, fitOnce } = useGraphCanvas(board.hidden);
  const tipRef = useRef<HTMLDivElement>(null);
  // Keep the first canvas view clear; expanding the filters is an explicit choice.
  const [legendOpen, setLegendOpen] = useState(false);

  // Data → the world's layout, buckets and animation bookkeeping. `reduced`
  // comes off the world because the hook keeps it live against the OS query.
  useEffect(() => {
    world.setSnapshot(board.snapshot, { reduced: world.reduced });
    fitOnce();
    redraw();
    repick(); // keep the tooltip honest across live refreshes
  }, [board.snapshot, world, fitOnce, redraw, repick]);

  // Legend filters: the world reads `hidden` live, so only a repaint is owed.
  useEffect(() => {
    redraw();
    repick();
  }, [board.hidden, redraw, repick]);

  // Re-entering the stage replays the reveal (CSS) and repaints fresh.
  useEffect(() => {
    if (active) redraw();
  }, [active, redraw]);

  // Edge-clamp the tooltip with its MEASURED size (TooltipHost's measure-then-
  // place pattern), before paint — width/height estimates drifted from the
  // real .graph-tip maxima and clipped hub tips at the right/bottom edges.
  useLayoutEffect(() => {
    const el = tipRef.current;
    const host = hostRef.current;
    if (!el || !host || !tip) return;
    const { left, top } = clampInto(
      tip,
      { w: el.offsetWidth, h: el.offsetHeight },
      { w: host.clientWidth, h: host.clientHeight },
      4,
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip, hostRef]);

  const snap = board.snapshot;
  const empty = snap !== null && snap.pks.length === 0;
  return (
    <div class={`graph-stage${active ? ' on' : ''}${dragCursor ? ' dragging' : ''}`} ref={hostRef}>
      <canvas ref={canvasRef} />
      {board.loading ? (
        <div class="graph-empty">Reading the graph…</div>
      ) : board.unavailable ? (
        <div class="graph-empty" role="status">
          <div>
            <p>{snap === null ? 'Epo can’t read the graph right now.' : 'Epo can’t refresh the graph. Showing the last available view.'}</p>
            <Button onClick={board.retry}>Try again</Button>
          </div>
        </div>
      ) : snap === null ? (
        <div class="graph-empty">
          Nothing to draw yet — log in and let the engine read a target's followers.
        </div>
      ) : empty ? (
        <div class="graph-empty">The graph is empty so far. Start the engine to grow it.</div>
      ) : null}

      {snap !== null && !empty ? <div class={legendOpen ? 'graph-legend' : 'graph-legend collapsed'}>
        <button
          type="button"
          class="graph-legend__head"
          onClick={() => setLegendOpen((open) => !open)}
          aria-expanded={legendOpen}
        >
          <Icon name="circle-nodes" />
          <span>Legend</span>
          <span class="graph-legend__total num">{snap ? commas(snap.pks.length) : '—'}</span>
          <Icon name="chevron-down" class="graph-legend__chev" />
        </button>
        <div class="graph-legend__body" hidden={!legendOpen}>
          <div class="gleg">
            {GRAPH_NODE_STATUSES.map((status) => {
              const off = board.hidden.has(status);
              return (
                <button
                  key={status}
                  type="button"
                  class={off ? 'gleg-row off' : 'gleg-row'}
                  title={off ? 'Show this status' : 'Hide this status'}
                  onClick={() => board.toggleStatus(status)}
                >
                  <span class="gleg-dot" style={swatchStyle(status)} />
                  <span class="gleg-label">{LEGEND_LABELS[status]}</span>
                  <span class="gleg-count num">{snap ? commas(snap.counts[status]) : '—'}</span>
                </button>
              );
            })}
          </div>
          <div class="graph-legend__foot">
            <Button wide icon="expand" onClick={() => fit(true)}>
              Fit view
            </Button>
            <p class="graph-legend__hint">
              Drag to pan · scroll to zoom · click a cluster core to frame it. Timed dots
              saturate as their clock nears the deadline.
            </p>
          </div>
        </div>
      </div> : null}

      {tip ? (
        <div class="graph-tip" ref={tipRef} style={`left:${tip.left}px;top:${tip.top}px`}>
          <div class="graph-tip__title">{tip.title}</div>
          {tip.lines.map((line) => (
            <div key={line} class="graph-tip__line">
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
