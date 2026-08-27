/** @jsx h */
/**
 * The stage bar — the slim rail across the top of the main region (right of
 * the console) that swaps what fills the stage body: the embedded Instagram
 * tab, the network graph, or the prune page. It is the ONLY strip of that
 * region the dashboard renderer owns while the tab is showing (main.ts starts
 * the tab view below it — heights must agree: STAGE_BAR_HEIGHT ↔ `.stagebar`).
 *
 * The selector is the console's own recessed segmented control (the `.seg`
 * recipe from primitives.css) stretched across the full bar width, with one
 * addition: the raised active segment is a real element (`.stageseg-thumb`)
 * that SLIDES between the equal-width tabs. Its geometry is data-driven —
 * `--seg-n` / `--seg-i` here feed the CSS — so adding a tab to TABS is the
 * whole change. Keyboard behavior mirrors ui/Segmented.tsx: roving tabindex
 * plus arrow keys.
 */
import { h } from 'preact';
import type { StageMode } from '@/types';
import { Icon } from '../ui/Icon';

const TABS: ReadonlyArray<{ key: StageMode; icon: string; brand?: boolean; label: string }> = [
  { key: 'tab', icon: 'instagram', brand: true, label: 'Instagram' },
  { key: 'graph', icon: 'circle-nodes', label: 'Graph' },
  { key: 'prune', icon: 'user-minus', label: 'Prune' },
];

export interface StageBarProps {
  stage: StageMode;
  onSelect(stage: StageMode): void;
  /** Live context shown inside the Graph tab (its node count). */
  aux?: string;
}

export function StageBar({ stage, onSelect, aux }: StageBarProps): h.JSX.Element {
  const idx = Math.max(
    0,
    TABS.findIndex((t) => t.key === stage),
  );

  const onKeyDown = (e: KeyboardEvent): void => {
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const next = TABS[(idx + dir + TABS.length) % TABS.length];
    if (!next) return;
    onSelect(next.key);
    const group = e.currentTarget as HTMLElement;
    const btn = group.querySelectorAll('button')[
      (idx + dir + TABS.length) % TABS.length
    ] as HTMLButtonElement | undefined;
    btn?.focus();
  };

  return (
    <div class="stagebar">
      <div
        class="stageseg"
        role="radiogroup"
        aria-label="Stage"
        data-tour="stageseg"
        style={`--seg-n:${TABS.length};--seg-i:${idx}`}
        onKeyDown={onKeyDown}
      >
        <span class="stageseg-thumb" aria-hidden="true" />
        {TABS.map((t) => {
          const on = t.key === stage;
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={on ? 'true' : 'false'}
              tabIndex={on ? 0 : -1}
              class={on ? 'active' : undefined}
              onClick={() => onSelect(t.key)}
            >
              <Icon name={t.icon} brand={t.brand} />
              <span>{t.label}</span>
              {t.key === 'graph' && aux !== undefined ? (
                <span class="stageseg-aux num">{aux}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
