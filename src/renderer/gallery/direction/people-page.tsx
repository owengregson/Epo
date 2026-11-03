/**
 * People (Targets + Queues as one stage page, spec §12.5): measured growth
 * first, then where Epo finds people and who is in progress — in words an
 * average person uses. Two columns only when the stage is wide enough.
 */
import { type JSX } from 'preact';
import { CHAIN, FUNNEL, GROWTH, LANES, WAITING_ROWS } from '@/renderer/gallery/direction/fixtures';
import { Meter } from '@/renderer/gallery/direction/instruments';
import { peopleColumns } from '@/renderer/gallery/direction/layout';
import { Icon } from '@/renderer/ui/Icon';

const W = 1000;
const H = 200;

function GrowthChart(): JSX.Element {
  const lo = 1080;
  const hi = 1300;
  const pts = GROWTH.map((v, i) => [(i / (GROWTH.length - 1)) * W, H - ((v - lo) / (hi - lo)) * H] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1] ?? [W, 0];
  return (
    <section class="dx-panel dx-chart" aria-label="Your followers over time">
      <div class="dx-panel__head">
        <h2>Your followers over time</h2>
        <div class="dx-seg dx-seg--small" role="radiogroup" aria-label="Range">
          {['14 days', '30 days', '90 days', 'All'].map((r) => (
            <button key={r} type="button" role="radio" aria-checked={r === '30 days'} class={r === '30 days' ? 'is-on' : undefined}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div class="dx-chart__num num">
        1,284 <span class="is-up">+182 in 30 days</span>
      </div>
      <div class="dx-chart__plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} class="dx-chart__grid" x1="0" x2={W} y1={H * g} y2={H * g} />
          ))}
          <path class="dx-chart__area" d={`${line} L${W} ${H} L0 ${H} Z`} />
          <path class="dx-chart__line" d={line} />
        </svg>
        <span class="dx-chart__dot" style={`left:${(last[0] / W) * 100}%;top:${(last[1] / H) * 100}%`} />
      </div>
      <div class="dx-chart__axis num" aria-hidden="true">
        {['Oct 5', 'Oct 12', 'Oct 19', 'Oct 26', 'Nov 3'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <p class="dx-chart__note">Measured once a day from your profile · calendar days</p>
    </section>
  );
}

function Finds(): JSX.Element {
  return (
    <section class="dx-panel" aria-label="Where Epo finds people">
      <div class="dx-panel__head">
        <h2>Where Epo finds people</h2>
      </div>
      <ol class="dx-chain">
        {CHAIN.map((s, i) => (
          <li key={s.handle} class={`is-${s.state}`}>
            <span class="dx-chain__step num">Step {i + 1}</span>
            <span class="dx-chain__who">
              <button type="button" class="dx-handle">
                {s.handle}
              </button>
              <span>{s.line}</span>
            </span>
          </li>
        ))}
      </ol>
      <div class="dx-funnel">
        {FUNNEL.map((f, i) => (
          <div key={f.label} class="dx-funnel__stage" style={`--w:${[100, 58, 26, 12][i]}%`}>
            <span class="dx-funnel__bar" />
            <span class="dx-funnel__label">{f.label}</span>
            <span class="dx-funnel__value num">{f.value}</span>
          </div>
        ))}
      </div>
      <div class="dx-kv">
        <span>Enough people for about 6 days</span>
        <Meter share={0.6} />
      </div>
      <div class="dx-kv">
        <span>Follow-back rate</span>
        <b>24% · 214 results</b>
      </div>
    </section>
  );
}

function InProgress(): JSX.Element {
  return (
    <section class="dx-panel" aria-label="In progress">
      <div class="dx-panel__head">
        <h2>In progress</h2>
      </div>
      <div class="dx-lanes" role="tablist" aria-label="Lanes">
        {LANES.map((l) => (
          <button key={l.key} type="button" role="tab" aria-selected={l.key === 'waiting'} class={l.key === 'waiting' ? 'is-on' : undefined}>
            {l.label} <span class="num">{l.count}</span>
          </button>
        ))}
      </div>
      <p class="dx-lanes__hint">People Epo followed, waiting to see if they follow back.</p>
      <ul class="dx-people">
        {WAITING_ROWS.map((r) => (
          <li key={r.handle}>
            <span class="dx-mono" aria-hidden="true">
              {r.handle.slice(1, 2).toUpperCase()}
            </span>
            <span class="dx-people__who">
              <button type="button" class="dx-handle">
                {r.handle}
              </button>
              <span>{r.meta}</span>
              {r.marker === 'outside' ? (
                <span class="dx-tag dx-tag--hold">
                  <Icon name="circle-exclamation" /> Changed outside Epo · not yet verified
                </span>
              ) : null}
            </span>
            <span class="dx-people__due num">
              <Meter share={r.progress} />
              {r.due}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PeoplePage({ stageWidth }: { stageWidth: number }): JSX.Element {
  return (
    <div class="dx-page dx-ppl" data-cols={peopleColumns(stageWidth)}>
      <header class="dx-page__head">
        <h1>People</h1>
        <p>Where Epo finds people, and who’s in progress.</p>
      </header>
      <GrowthChart />
      <div class="dx-ppl__cols">
        <Finds />
        <InProgress />
      </div>
    </div>
  );
}
