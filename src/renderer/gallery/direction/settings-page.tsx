/**
 * The Settings stage frame: header (mode switch, search, save state), the
 * section rail — or chips on a narrow stage — and "What to expect" where the
 * stage is wide enough. The layout follows the stage width (spec §6, T2 §14.2).
 */
import { type ComponentChildren, type JSX } from 'preact';
import { PLAN_DAY } from '@/renderer/gallery/direction/fixtures';
import { Meter, PlanStrip } from '@/renderer/gallery/direction/instruments';
import { settingsLayout } from '@/renderer/gallery/direction/layout';
import { Icon } from '@/renderer/ui/Icon';

type SettingsMode = 'easy' | 'advanced';

const EASY_SECTIONS: ReadonlyArray<[string, string, string]> = [
  ['pace', 'Growth pace', 'gauge-high'],
  ['when', 'When Epo works', 'moon'],
  ['who', 'Who to follow', 'bullseye'],
  ['unfollow', 'Unfollowing', 'user-minus'],
  ['protect', 'Protection', 'shield-halved'],
  ['boost', 'Boost', 'bolt'],
  ['practice', 'Practice & app', 'circle-play'],
];

const ADVANCED_SECTIONS: ReadonlyArray<[string, string, string]> = [
  ['timing', 'Timing', 'stopwatch'],
  ['finding', 'Finding new people', 'magnifying-glass-chart'],
  ['limits', 'Limits & reading', 'lock'],
  ['hood', 'Under the hood', 'sliders'],
  ['diag', 'Diagnostics', 'wave-square'],
];

function Rail({ mode, active }: { mode: SettingsMode; active: string }): JSX.Element {
  const item = ([key, label, icon]: [string, string, string]): JSX.Element => (
    <button
      key={key}
      type="button"
      class={key === active ? 'is-on' : undefined}
      aria-current={key === active ? 'true' : undefined}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {mode === 'advanced' && key === 'pace' ? <i class="dx-rail__dot" title="1 value set by you" /> : null}
    </button>
  );
  return (
    <nav class="dx-rail" aria-label="Settings sections">
      {EASY_SECTIONS.map(item)}
      {mode === 'advanced' ? (
        <>
          <span class="dx-rail__sep">Advanced</span>
          {ADVANCED_SECTIONS.map(item)}
        </>
      ) : null}
    </nav>
  );
}

function Chips({ mode, active }: { mode: SettingsMode; active: string }): JSX.Element {
  const all = mode === 'advanced' ? [...EASY_SECTIONS, ...ADVANCED_SECTIONS] : EASY_SECTIONS;
  return (
    <nav class="dx-set__chips" aria-label="Settings sections">
      {all.map(([key, label]) => (
        <button key={key} type="button" class={key === active ? 'dx-chip is-on' : 'dx-chip'}>
          {label}
        </button>
      ))}
    </nav>
  );
}

/** The live consequences of the current choices; Easy shows no per-hour figures. */
function Expect({ mode }: { mode: SettingsMode }): JSX.Element {
  const week = [38, 44, 41, 47, 36, 29, 44];
  return (
    <aside class="dx-expect" aria-label="What to expect">
      <h3>What to expect</h3>
      <div class="dx-expect__block">
        <span class="dx-expect__k">Today</span>
        <span class="dx-expect__v num">About 44 actions in 5 sessions</span>
        <PlanStrip sessions={PLAN_DAY} now={14.5} />
      </div>
      <div class="dx-expect__block">
        <span class="dx-expect__k">Most days</span>
        <span class="dx-expect__v num">29–47 actions</span>
      </div>
      <div class="dx-expect__block">
        <span class="dx-expect__k">This week</span>
        <div class="dx-expect__week" aria-hidden="true">
          {week.map((v, i) => (
            <i key={`${i}-${v}`} style={`height:${(v / 48) * 100}%`} />
          ))}
        </div>
      </div>
      <div class="dx-expect__block">
        <span class="dx-expect__k">Safety</span>
        <Meter share={0.48} tick={0.65} />
        <span class="dx-expect__note">Epo’s own work uses up to 48% of the lowest daily follow limit Instagram is known to apply.</span>
      </div>
      {mode === 'advanced' ? (
        <div class="dx-expect__block">
          <span class="dx-expect__k">Limits</span>
          <span class="dx-expect__v num">At most 18 an hour · hard stop 65 a day</span>
          <button type="button" class="dx-link">
            1 value set by you · Review
          </button>
        </div>
      ) : null}
    </aside>
  );
}

export interface SettingsPageProps {
  mode: SettingsMode;
  stageWidth: number;
  active: string;
  /** Open the page scrolled so this element sits near the top (a board shows what it is about). */
  scrollTo?: string;
  children: ComponentChildren;
}

/** How far above the target the scrolled page stops, so the lines before it still give context. */
const SCROLL_CONTEXT_PX = 200;

function scrollToTarget(page: HTMLElement | null, selector: string | undefined): void {
  const target = selector && page ? page.querySelector<HTMLElement>(selector) : null;
  if (page && target) page.scrollTop = Math.max(0, target.offsetTop - SCROLL_CONTEXT_PX);
}

export function SettingsPage({ mode, stageWidth, active, scrollTo, children }: SettingsPageProps): JSX.Element {
  const layout = settingsLayout(stageWidth);
  return (
    <div class="dx-set" data-layout={layout} data-mode={mode} ref={(el) => scrollToTarget(el, scrollTo)}>
      <header class="dx-set__head">
        <h1>Settings</h1>
        <div class="dx-seg" role="radiogroup" aria-label="Settings mode">
          <button type="button" role="radio" aria-checked={mode === 'easy'} class={mode === 'easy' ? 'is-on' : undefined}>
            Easy
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'advanced'}
            class={mode === 'advanced' ? 'is-on' : undefined}
          >
            Advanced
          </button>
        </div>
        <span class="dx-search">
          <Icon name="magnifying-glass" />
          <span>Search settings</span>
          <kbd>/</kbd>
        </span>
        <span class="dx-save">
          <Icon name="check" /> All changes saved
        </span>
      </header>
      {layout === 'wide' ? null : (
        <div class="dx-set__summary num">
          <span>Today: about 44 actions in 5 sessions · next at 5:40 PM</span>
          <button type="button" class="dx-link">
            Details <Icon name="chevron-down" />
          </button>
        </div>
      )}
      {layout === 'narrow' ? <Chips mode={mode} active={active} /> : null}
      <div class="dx-set__grid">
        {layout === 'narrow' ? null : <Rail mode={mode} active={active} />}
        <main class="dx-set__content">{children}</main>
        {layout === 'wide' ? <Expect mode={mode} /> : null}
      </div>
    </div>
  );
}
