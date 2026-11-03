/**
 * Boost preferences (spec §8.6): the only place to choose how long a Boost lasts (the sidebar's one button
 * starts it with this length), whether to keep accepting follow requests during it, what changes while it
 * runs, and — while one is on — when it ends, with End Boost.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { BOOST_COPY } from '@/renderer/copy/boost';
import { Icon } from '@/renderer/ui/Icon';
import { RadioChips } from '@/renderer/ui/RadioCards';
import { ControlError, SwitchRow } from '../fields/controls';
import { fill, timeLabel } from '../format';
import type { SectionProps, StageApi } from '../stage-api';

const HOURS_KEY = 'pref:boost.hours';
const ACCEPT_KEY = 'pref:boost.acceptRequests';
/** Where the sidebar marks its Boost control, so "Show me" can point at it. */
const BOOST_CONTROL = '[data-boost-control]';

function BoostOn({ s }: { s: StageApi }): JSX.Element | null {
  const [ending, setEnding] = useState(false);
  const b = s.status?.basis === 'built' ? (s.status.boost ?? null) : null;
  if (b === null || b.endsAt === null || (b.state !== 'on' && b.state !== 'paused' && b.state !== 'waiting')) return null;
  const end = (): void => {
    setEnding(true);
    window.epo.endBoost().then(
      (r) => {
        setEnding(false);
        if (r.kind === 'refused') s.toast('error', BOOST_COPY.settings.endFailed);
      },
      () => {
        setEnding(false);
        s.toast('error', BOOST_COPY.settings.endFailed);
      },
    );
  };
  return (
    <div class="set-boost-on" role="status">
      <Icon name="bolt" />
      <span class="num">{fill(BOOST_COPY.settings.on, { time: timeLabel(b.endsAt), n: b.followsDuring ?? 0 })}</span>
      <button type="button" class="set-btn" disabled={ending} onClick={end}>
        {BOOST_COPY.settings.end}
      </button>
    </div>
  );
}

export function BoostSection({ s }: SectionProps): JSX.Element {
  const { view } = s;
  const hours = s.c.value<number>(HOURS_KEY, view.prefs.boost.hours);
  const choices = view.options.boostHours.choices;
  const showMe = (): void => {
    const el = document.querySelector<HTMLElement>(BOOST_CONTROL);
    el?.focus();
    el?.classList.add('is-found');
  };
  return (
    <>
      <p class="set-sec__lead">{BOOST_COPY.settings.lead}</p>
      <BoostOn s={s} />
      <div class="set-row set-row--stack" data-row="boost.hours">
        <span class="set-row__k">{BOOST_COPY.settings.defaultLength}</span>
        <RadioChips
          class="set-choice-chips"
          label={BOOST_COPY.settings.defaultLength}
          items={choices.includes(hours) ? choices : [...choices, hours].sort((a, b) => a - b)}
          selected={hours}
          onSelect={(h) => s.send(HOURS_KEY, [{ op: 'pref', key: 'boost.hours', value: h }], h)}
          render={(h) => fill(BOOST_COPY.settings.hours, { h })}
        />
        <ControlError s={s} k={HOURS_KEY} />
      </div>
      <SwitchRow
        label={BOOST_COPY.settings.keepAccepting}
        help={BOOST_COPY.settings.keepAcceptingHelp}
        checked={s.c.value<boolean>(ACCEPT_KEY, view.prefs.boost.acceptRequests)}
        onChange={(v) => s.send(ACCEPT_KEY, [{ op: 'pref', key: 'boost.acceptRequests', value: v }], v)}
        s={s}
        k={ACCEPT_KEY}
        dataRow="boost.acceptRequests"
      />
      <ul class="set-checklist">
        {BOOST_COPY.settings.checklist.map((line) => (
          <li key={line}>
            <Icon name="check" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <p class="set-sec__hint">
        {BOOST_COPY.settings.whereToStart}{' '}
        {typeof document !== 'undefined' && document.querySelector(BOOST_CONTROL) !== null ? (
          <button type="button" class="link-btn" onClick={showMe}>
            {BOOST_COPY.settings.showMe}
          </button>
        ) : null}
      </p>
    </>
  );
}
