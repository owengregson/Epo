/**
 * Growth pace (spec §6.4): three intent cards with the day law's typical number from the view, the range
 * most days land in, the share of Instagram's lowest known daily limit, and the feasibility line when the
 * schedule is too short. No per-hour figure in Easy; a custom mix shows as its own selected card.
 */
import type { JSX } from 'preact';
import { type CardChoice, RadioCards } from '@/renderer/ui/RadioCards';
import { PACE_CARDS, type PaceCardId } from '@/shared/settings-intent';
import type { SettingsOp } from '@/shared/settings-ops';
import { PACE_COPY, RECOMMENDED } from '../copy/choices';
import { STAGE_COPY } from '../copy/sections';
import { expectHint } from '../ExpectPanel';
import { ControlError } from '../fields/controls';
import { fill } from '../format';
import type { SectionProps, StageApi } from '../stage-api';

const KEY = 'pace:card';
const CARD_IDS = Object.keys(PACE_CARDS) as PaceCardId[];

export function paceOps(card: PaceCardId): SettingsOp[] {
  const p = PACE_CARDS[card];
  return [
    { op: 'intent', key: 'activity', value: p.activity },
    { op: 'intent', key: 'caution', value: p.caution },
  ];
}

/** The safety meter: Epo's own maximum as a share of the lowest daily limit, the hard stop as its end tick. */
function Safety({ s }: { s: StageApi }): JSX.Element {
  const t = s.view.typical;
  const share = Math.min(1, t.shareOfLowWall);
  const stop = t.automaticMax > 0 ? Math.min(1, (t.ceiling / t.automaticMax) * t.shareOfLowWall) : share;
  return (
    <div class="set-safety">
      <div class="set-meter" aria-hidden="true">
        <i style={`width:${share * 100}%`} />
        <b style={`left:${stop * 100}%`} />
      </div>
      <p class="num">{fill(PACE_COPY.safety, { p: Math.round(t.shareOfLowWall * 100) })}</p>
    </div>
  );
}

/** "Your own mix": values set in Advanced make the day no preset; it reads as selected, with a way back. */
function CustomCard({ s }: { s: StageApi }): JSX.Element {
  return (
    <div class="radio-card radio-card--custom is-on" role="note">
      <span class="radio-card__top">
        <span class="radio-card__title">{PACE_COPY.custom}</span>
      </span>
      <span class="radio-card__metric num">{fill(PACE_COPY.metric, { n: s.view.typical.perDay.typical })}</span>
      <span class="radio-card__line">
        {PACE_COPY.customLine}{' '}
        <button type="button" class="link-btn" onClick={() => s.openAdvanced('pace')}>
          {STAGE_COPY.review}
        </button>
      </span>
    </div>
  );
}

export function PaceSection({ s }: SectionProps): JSX.Element {
  const { view } = s;
  const custom = view.easy.pace === 'custom';
  const selected = s.c.value<PaceCardId | null>(KEY, custom ? null : (view.easy.pace as PaceCardId));
  const choices: CardChoice<PaceCardId>[] = CARD_IDS.map((id) => {
    const opt = view.options.paceCards.find((p) => p.id === id);
    return {
      value: id,
      title: PACE_COPY.cards[id].title,
      metric: opt ? fill(PACE_COPY.metric, { n: opt.perDay.typical }) : undefined,
      line: PACE_COPY.cards[id].line,
      recommended: id === RECOMMENDED.pace,
    };
  });
  const preview = (id: PaceCardId | null): void => {
    const opt = id === null ? undefined : view.options.paceCards.find((p) => p.id === id);
    expectHint.value = id === null || opt === undefined ? null : { choice: PACE_COPY.cards[id].title, perDay: opt.perDay.typical };
  };
  const feas = view.typical.feasibility;
  return (
    <>
      <RadioCards
        label={PACE_COPY.label}
        choices={choices}
        selected={selected}
        onSelect={(id) => s.send(KEY, paceOps(id), id)}
        onPreview={preview}
        pending={s.c.pending(KEY)}
      />
      {custom && selected === null ? <CustomCard s={s} /> : null}
      <ControlError s={s} k={KEY} />
      <p class="set-sec__foot">{PACE_COPY.foot}</p>
      <p class="set-sec__line num">
        {fill(PACE_COPY.range, { lo: view.typical.perDay.low, hi: view.typical.perDay.high })}
      </p>
      <Safety s={s} />
      {feas.kind === 'short' ? (
        <p class="set-feas num" role="status">
          {fill(PACE_COPY.feasibility, { n: feas.reachablePerDay })}
        </p>
      ) : null}
    </>
  );
}
