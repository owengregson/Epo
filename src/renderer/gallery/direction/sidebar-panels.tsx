/**
 * The column's middle: Today (the plan strip and the one Boost control), Get
 * started on a first run, Results, and Recent activity — hairlines, not boxes.
 */
import { type JSX } from 'preact';
import { type FeedEntry, SPARK } from '@/renderer/gallery/direction/fixtures';
import { PlanStrip, Said, Spark } from '@/renderer/gallery/direction/instruments';
import type { BoostState, ResultsSpec, TodaySpec } from '@/renderer/gallery/direction/postures';
import { Icon } from '@/renderer/ui/Icon';

/** The only Boost control: one tap with the length saved in Settings. */
function BoostControl({ state }: { state: BoostState }): JSX.Element {
  if (state === 'on') {
    return (
      <div class="dx-band">
        <Icon name="bolt" />
        <span class="dx-band__text">
          <b>Boost on</b> · ends 9:40 PM · <span class="num">7 h 12 m</span> left
        </span>
        <button type="button" class="dx-btn dx-btn--small">
          End Boost
        </button>
      </div>
    );
  }
  if (state === 'paused') {
    return (
      <div class="dx-band is-paused">
        <Icon name="bolt" />
        <span class="dx-band__text">
          <b>Boost on until 9:40 PM</b> — Epo is stopped. Press Start to use it.
        </span>
        <button type="button" class="dx-btn dx-btn--small">
          End Boost
        </button>
      </div>
    );
  }
  return (
    <div class="dx-today__title">
      <h3>Today’s plan</h3>
      <button
        type="button"
        class="dx-btn dx-btn--boost"
        disabled={state === 'unavailable'}
        title={state === 'unavailable' ? 'Epo needs your attention first' : undefined}
      >
        <Icon name="bolt" />
        Boost for 12 h
      </button>
    </div>
  );
}

/** Hover card under the Boost button: what one tap would do, before it is pressed. */
function BoostPreview(): JSX.Element {
  return (
    <div class="dx-pop dx-pop--boost" role="tooltip">
      <p>
        Until <b>4:12 AM</b> · about <b>+8 follows</b> today, within your usual limits · <b>4</b> unfollows will
        wait
      </p>
      <button type="button" class="dx-link">
        Change length in Settings
      </button>
    </div>
  );
}

export function TodayZone({ t, preview, height }: { t: TodaySpec; preview: boolean; height: number }): JSX.Element {
  return (
    <section class="dx-zone dx-today" data-zone="today" style={`height:${height}px`}>
      <BoostControl state={t.boost} />
      <PlanStrip sessions={t.sessions} now={t.now} band={t.band} />
      <p class="dx-today__sum num">{t.summary}</p>
      <p class="dx-today__next">{t.next}</p>
      {preview ? <BoostPreview /> : null}
    </section>
  );
}

/** First run: three steps that tick off live, in the space Today and Results use. */
export function GetStarted({ height }: { height: number }): JSX.Element {
  return (
    <section class="dx-zone dx-start" data-zone="get-started" style={`height:${height}px`}>
      <div class="dx-start__title">
        <h3>Get started</h3>
        <span class="num">1 of 3</span>
      </div>
      <div class="dx-start__bar" aria-hidden="true">
        <i style="width:33.3%" />
      </div>
      <ol>
        <li class="is-done">
          <span class="dx-start__tick">
            <Icon name="check" />
          </span>
          Sign in to Instagram
        </li>
        <li class="is-now">
          <span class="dx-start__tick" />
          Choose a starting account
          <button type="button" class="dx-btn dx-btn--small">
            Choose <Icon name="arrow-right-long" />
          </button>
        </li>
        <li>
          <span class="dx-start__tick" />
          Press Start
        </li>
      </ol>
    </section>
  );
}

/** Results: the day's net as the one hero number, the follower count with its age, follow-backs. */
export function ResultsZone({ r, height }: { r: ResultsSpec; height: number }): JSX.Element {
  return (
    <section class="dx-zone dx-res" data-zone="results" style={`height:${height}px`}>
      <div class="dx-res__top">
        <div>
          <div class={r.up ? 'dx-res__hero num is-up' : 'dx-res__hero num'}>{r.net.replace('-', '−')}</div>
          <div class="dx-res__label">followers today</div>
        </div>
        <div class="dx-res__spark">
          <Spark values={SPARK} />
          <span>last 7 days</span>
        </div>
      </div>
      <p class="dx-res__followers num">
        {r.followers} <span>· {r.age}</span>
      </p>
      <p class="dx-res__backs">{r.backs}</p>
    </section>
  );
}

function FeedItem({ e }: { e: FeedEntry }): JSX.Element {
  if ('divider' in e) return <div class="dx-feed__divider">{e.divider}</div>;
  if ('group' in e) return <div class="dx-feed__group">{e.group}</div>;
  const cls = ['dx-feed__row', e.fresh ? 'is-fresh' : '', e.detail ? 'is-two' : ''].filter(Boolean).join(' ');
  return (
    <div class={cls} data-tone={e.tone}>
      <span class="dx-feed__disc">
        <Icon name={e.glyph} />
      </span>
      <span class="dx-feed__text">
        <span class="dx-feed__line">
          <Said parts={e.parts} />
        </span>
        {e.detail ? <span class="dx-feed__detail">{e.detail}</span> : null}
      </span>
      <time class="num">{e.time}</time>
    </div>
  );
}

/** Recent activity: the column's only scroller; typed rows, day groups, the "Since you left" divider. */
export function ActivityZone({ feed, height, fresh }: { feed: readonly FeedEntry[]; height: number | null; fresh: number }): JSX.Element {
  return (
    <section class="dx-zone dx-feed" data-zone="activity" style={height === null ? undefined : `height:${height}px`}>
      <div class="dx-feed__head">
        <h3>Recent activity</h3>
        {fresh > 0 ? (
          <button type="button" class="dx-pill dx-pill--new">
            <Icon name="arrow-up" /> {fresh} new
          </button>
        ) : null}
      </div>
      {feed.length === 0 ? (
        <p class="dx-feed__empty">Nothing yet today. Activity shows up here as Epo works.</p>
      ) : (
        <div class="dx-feed__list">
          {feed.map((e, i) => (
            <FeedItem key={'id' in e ? e.id : `${i}`} e={e} />
          ))}
        </div>
      )}
    </section>
  );
}
