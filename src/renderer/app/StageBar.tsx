/**
 * The stage bar (spec §12.4): five equal tabs across the top of the window
 * right of the console — Live · People · Graph · Prune · Settings — and, on
 * Live, a line saying whether Epo is using the Instagram page. It is the only
 * strip of that region the renderer owns while Instagram shows (the page starts
 * right below it). Keyboard: roving tabindex plus arrow keys; ⌘1–⌘5 and ⌘, come
 * from the application menu, so they work while Instagram has focus.
 */
import { type JSX } from 'preact';
import { useNow } from '@/renderer/app/clock';
import { activitySignal } from '@/renderer/app/live-signals';
import { statusSignal } from '@/renderer/app/shell-context';
import { commas, mmss } from '@/renderer/lib/format';
import { Icon } from '@/renderer/ui/Icon';
import { STAGE_MODES, type StageMode } from '@/shared/stage-mode';

interface Tab {
  readonly label: string;
  readonly icon: string;
  readonly brand?: boolean;
}

/** Labels and icons, in the menu's order (owner Q28: the fourth is Prune). */
const TABS: Readonly<Record<StageMode, Tab>> = {
  tab: { label: 'Live', icon: 'instagram', brand: true },
  people: { label: 'People', icon: 'users' },
  graph: { label: 'Graph', icon: 'circle-nodes' },
  prune: { label: 'Prune', icon: 'user-minus' },
  settings: { label: 'Settings', icon: 'sliders' },
};

/** Platform modifier for the shortcut hints. */
const MOD = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';

/** A tab's tooltip: its name and its shortcut (Settings also answers ⌘,). */
export function tabTip(mode: StageMode): string {
  const n = STAGE_MODES.indexOf(mode) + 1;
  const keys = mode === 'settings' ? `${MOD}${n} or ${MOD},` : `${MOD}${n}`;
  return `${TABS[mode].label} · ${keys}`;
}

const AT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const HOUR_SECONDS = 3600;

/** The Live context: busy now, the next use of the page, or free to browse. */
export function liveContextText(busy: boolean, nextAt: number | null, now: number): string {
  if (busy) return 'Epo is using this page';
  if (nextAt === null || nextAt <= now) return 'You can browse freely';
  const seconds = (nextAt - now) / 1000;
  return seconds < HOUR_SECONDS
    ? `Epo uses this page again in ${mmss(seconds)}`
    : `Epo uses this page again at ${AT.format(nextAt)}`;
}

/** Reads the activity and status pushes itself, so they re-render this line, not the bar. */
function LiveContext(): JSX.Element {
  const busy = activitySignal.value?.busy ?? false;
  const status = statusSignal.value;
  const nextAt = status?.state === 'running' ? status.nextActionAt : null;
  const now = useNow('second', !busy && nextAt !== null);
  return <span class="stagebar-context num">{liveContextText(busy, nextAt, now)}</span>;
}

/** The Live tab's dot: Epo is using the page while you are on another stage. */
function LiveDot(): JSX.Element | null {
  return activitySignal.value?.busy ? <span class="stageseg-dot" aria-hidden="true" /> : null;
}

export interface StageBarProps {
  stage: StageMode;
  onSelect(stage: StageMode): void;
  /** The graph's node count, shown inside the Graph tab once known. */
  graphCount?: number | null;
}

export function StageBar({ stage, onSelect, graphCount }: StageBarProps): JSX.Element {
  const idx = STAGE_MODES.indexOf(stage);

  const onKeyDown = (e: KeyboardEvent): void => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const nx = (idx + dir + STAGE_MODES.length) % STAGE_MODES.length;
    const next = STAGE_MODES[nx];
    if (next === undefined) return;
    onSelect(next);
    const btn = (e.currentTarget as HTMLElement).querySelectorAll('button')[nx] as HTMLButtonElement | undefined;
    btn?.focus();
  };

  return (
    <div class="stagebar">
      <div
        class="stageseg"
        role="radiogroup"
        aria-label="Pages"
        data-tour="stageseg"
        style={`--seg-n:${STAGE_MODES.length};--seg-i:${idx}`}
        onKeyDown={onKeyDown}
      >
        <span class="stageseg-thumb" aria-hidden="true" />
        {STAGE_MODES.map((mode) => {
          const on = mode === stage;
          const tab = TABS[mode];
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={on ? 'true' : 'false'}
              tabIndex={on ? 0 : -1}
              class={on ? 'active' : undefined}
              data-stage-tab={mode}
              data-tip={tabTip(mode)}
              onClick={() => onSelect(mode)}
            >
              <Icon name={tab.icon} brand={tab.brand} />
              <span>{tab.label}</span>
              {mode === 'tab' && !on ? <LiveDot /> : null}
              {mode === 'graph' && graphCount != null ? (
                <span class="stageseg-aux num">{commas(graphCount)}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {stage === 'tab' ? <LiveContext /> : null}
    </div>
  );
}
