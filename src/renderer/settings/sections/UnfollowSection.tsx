/**
 * Unfollowing (spec §6.4): how long to wait for a follow-back, what happens when someone follows back, and
 * whether to prune people you followed yourself. Turning pruning on asks first, with the last census's
 * numbers (or a plain "Epo checks first" when there is none); nothing is sent until you answer.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useNow } from '@/renderer/app/clock';
import { useShellControls } from '@/renderer/app/shell-context';
import { type CardChoice, RadioCards, RadioChips } from '@/renderer/ui/RadioCards';
import { CLEANUP_LEVELS, type CleanupLevel, MUTUAL_POLICIES, type MutualPolicy, PATIENCES, type Patience } from '@/shared/settings-intent';
import { ConfirmSheet } from '../ConfirmSheet';
import { RECOMMENDED, UNFOLLOW_COPY } from '../copy/choices';
import { ControlError, Sub } from '../fields/controls';
import { agoLabel, daysLabel, fill } from '../format';
import type { SectionProps, StageApi } from '../stage-api';

const CLEANUP_KEY = 'intent:cleanup';

/** The opt-in sheet for pruning your own follows: the census numbers when Epo has them. */
export function CleanupConfirm({ s, level, onClose }: { s: StageApi; level: CleanupLevel; onClose(): void }): JSX.Element {
  const now = useNow('minute');
  const { showStage } = useShellControls();
  const census = s.facts?.built ? (s.facts.cleanup?.census ?? null) : null;
  const body = census === null
    ? UNFOLLOW_COPY.confirmNoCensus
    : fill(UNFOLLOW_COPY.confirm, { n: census.candidates, ago: agoLabel(census.at, now), k: census.protectedAmong });
  return (
    <ConfirmSheet
      title={UNFOLLOW_COPY.confirmTitle}
      onCancel={onClose}
      actions={[
        { label: UNFOLLOW_COPY.confirmYes, tone: 'primary', run: () => {
          onClose();
          s.send(CLEANUP_KEY, [{ op: 'intent', key: 'cleanup', value: level }], level);
        } },
        { label: UNFOLLOW_COPY.confirmReview, run: () => {
          onClose();
          showStage('prune');
        } },
        { label: UNFOLLOW_COPY.confirmNo, run: onClose },
      ]}
    >
      <p class="num">{body}</p>
    </ConfirmSheet>
  );
}

export function UnfollowSection({ s }: SectionProps): JSX.Element {
  const { view } = s;
  const waitKey = 'intent:patience';
  const mutualKey = 'intent:mutuals';
  const [asking, setAsking] = useState<CleanupLevel | null>(null);
  const patience = s.c.value<Patience>(waitKey, view.intent.patience);
  const hold = view.options.patience[patience].holdDays;
  const mutuals: CardChoice<MutualPolicy>[] = MUTUAL_POLICIES.map((m) => ({
    value: m,
    title: UNFOLLOW_COPY.mutualTitle[m],
    line: fill(UNFOLLOW_COPY[m], { hold: daysLabel(hold) }),
    recommended: m === RECOMMENDED.intent.mutuals,
  }));
  const cleanup = s.c.value<CleanupLevel>(CLEANUP_KEY, view.intent.cleanup);
  const levels: CardChoice<CleanupLevel>[] = CLEANUP_LEVELS.map((l) => ({
    value: l,
    title: UNFOLLOW_COPY.cleanup[l],
    recommended: l === RECOMMENDED.intent.cleanup,
  }));
  const pickCleanup = (l: CleanupLevel): void => {
    if (l === cleanup) return;
    if (cleanup === 'off') setAsking(l);
    else s.send(CLEANUP_KEY, [{ op: 'intent', key: 'cleanup', value: l }], l);
  };
  return (
    <>
      <div class="set-row set-row--stack" data-row="patience">
        <span class="set-row__k set-row__k--wide">{UNFOLLOW_COPY.wait}</span>
        <RadioChips
          class="set-choice-chips"
          label={UNFOLLOW_COPY.wait}
          items={PATIENCES}
          selected={patience}
          onSelect={(p) => s.send(waitKey, [{ op: 'intent', key: 'patience', value: p }], p)}
          render={(p) => daysLabel(view.options.patience[p].waitDays)}
        />
        <ControlError s={s} k={waitKey} />
      </div>
      <Sub>{UNFOLLOW_COPY.mutuals}</Sub>
      <RadioCards
        class="radio-cards--two"
        label={UNFOLLOW_COPY.mutuals}
        dataRow="unfollow.mutuals"
        choices={mutuals}
        selected={s.c.value<MutualPolicy>(mutualKey, view.intent.mutuals)}
        onSelect={(m) => s.send(mutualKey, [{ op: 'intent', key: 'mutuals', value: m }], m)}
        pending={s.c.pending(mutualKey)}
      />
      <ControlError s={s} k={mutualKey} />
      <Sub>{UNFOLLOW_COPY.own}</Sub>
      <p class="set-sec__hint">{UNFOLLOW_COPY.ownHelp}</p>
      <RadioCards
        label={UNFOLLOW_COPY.own}
        dataRow="unfollow.cleanup"
        choices={levels}
        selected={cleanup}
        onSelect={pickCleanup}
        pending={s.c.pending(CLEANUP_KEY)}
      />
      {asking !== null ? <CleanupConfirm s={s} level={asking} onClose={() => setAsking(null)} /> : null}
      <ControlError s={s} k={CLEANUP_KEY} />
    </>
  );
}
