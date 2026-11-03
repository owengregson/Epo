/**
 * Protection (spec §7.8), the same in Easy and Advanced: people, bio keywords, verified accounts, what is
 * always kept, and a live summary from the facts. An unknown count shows "—" with the reason, never 0.
 */
import type { JSX } from 'preact';
import { PROTECTION_COPY } from '../copy/fields';
import { Sub, SwitchRow } from '../fields/controls';
import { PeopleList } from '../fields/PeopleList';
import { WordChips } from '../fields/WordChips';
import type { SectionProps, StageApi } from '../stage-api';
import { Ticked } from '../Ticked';

/** "Protecting 214 of the 1,830 accounts Epo has seen you follow · Kept so far: 12 · …" from the facts. */
export function ProtectionSummary({ s }: { s: StageApi }): JSX.Element {
  const p = s.facts?.built ? s.facts.protection : null;
  const dash = PROTECTION_COPY.unknown;
  const values = {
    p: p === null ? dash : p.protectedFollowing,
    f: p?.followingKnown ?? dash,
    k: p === null ? dash : p.kept.total,
    u: p === null ? dash : p.bioUnread,
  };
  return (
    <div class="set-summary-box" role="status" aria-live="polite">
      <p class="num">
        <Ticked template={PROTECTION_COPY.summary} values={values} />
      </p>
      {p === null ? <p class="set-sec__hint">{PROTECTION_COPY.unknownWhy}</p> : null}
    </div>
  );
}

export function ProtectionSection({ s }: SectionProps): JSX.Element {
  const { view } = s;
  const verifiedKey = 'protect:keepVerified';
  return (
    <>
      <ProtectionSummary s={s} />
      <Sub>{PROTECTION_COPY.people}</Sub>
      <PeopleList s={s} />
      <Sub>{PROTECTION_COPY.words}</Sub>
      <WordChips s={s} />
      <p class="set-sec__hint">{view.protection.wordMatch === 'whole-word' ? PROTECTION_COPY.wordHintWhole : PROTECTION_COPY.wordHint}</p>
      <SwitchRow
        label={PROTECTION_COPY.verified}
        help={PROTECTION_COPY.verifiedHelp}
        checked={s.c.value<boolean>(verifiedKey, view.protection.keepVerified)}
        onChange={(v) => s.send(verifiedKey, [{ op: 'protect-rule', rule: 'keepVerified', value: v }], v)}
        s={s}
        k={verifiedKey}
        dataRow="protection.verified"
      />
      <p class="set-sec__hint">{PROTECTION_COPY.alsoKept}</p>
      <p class="set-sec__hint">{PROTECTION_COPY.ownFollow}</p>
    </>
  );
}
