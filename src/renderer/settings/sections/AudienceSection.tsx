/**
 * Who to follow (spec §6.4): the starting account, the account-size and "Prefer" cards (a value set in
 * Advanced shows as "Set in Advanced", never as a wrong card), the private-account edge, and follow
 * requests — accepting them is growth, so it lives here.
 */
import type { JSX } from 'preact';
import { type CardChoice, RadioCards } from '@/renderer/ui/RadioCards';
import { AUDIENCE_FOCUSES, AUDIENCE_SIZES, type AudienceFocus, type AudienceSize } from '@/shared/settings-intent';
import { AUDIENCE_COPY, RECOMMENDED } from '../copy/choices';
import { ControlError, Sub, SwitchRow } from '../fields/controls';
import { SeedField } from '../fields/SeedField';
import { fill } from '../format';
import type { SectionProps, StageApi } from '../stage-api';

function Custom({ s }: { s: StageApi }): JSX.Element {
  return (
    <p class="set-note">
      {AUDIENCE_COPY.custom}{' '}
      <button type="button" class="link-btn" onClick={() => s.openAdvanced('audience')}>
        {AUDIENCE_COPY.review}
      </button>
    </p>
  );
}

function Requests({ s }: { s: StageApi }): JSX.Element {
  const key = 'pref:acceptRequests';
  const on = s.c.value<boolean>(key, s.view.prefs.acceptRequests);
  const priv = s.facts?.built ? s.facts.ownAccount.isPrivate : null;
  const pill = priv === null ? null : (
    <span class="set-tag">{priv ? AUDIENCE_COPY.privatePill : AUDIENCE_COPY.publicPill}</span>
  );
  return (
    <SwitchRow
      label={AUDIENCE_COPY.accept}
      help={AUDIENCE_COPY.acceptHelp}
      aside={pill}
      checked={on}
      onChange={(v) => s.send(key, [{ op: 'pref', key: 'acceptRequests', value: v }], v)}
      s={s}
      k={key}
      dataRow="acceptRequests"
    />
  );
}

export function AudienceSection({ s }: SectionProps): JSX.Element {
  const { view } = s;
  const sizeKey = 'intent:audienceSize';
  const focusKey = 'intent:audienceFocus';
  const privKey = 'intent:preferPrivate';
  const sizes: CardChoice<AudienceSize>[] = AUDIENCE_SIZES.map((z) => ({
    value: z,
    title: AUDIENCE_COPY.sizes[z],
    line: fill(AUDIENCE_COPY.sizeLine[z], { min: view.options.size[z].min, max: view.options.size[z].max }),
    recommended: z === RECOMMENDED.intent.audienceSize,
  }));
  const focuses: CardChoice<AudienceFocus>[] = AUDIENCE_FOCUSES.map((f) => ({
    value: f,
    title: AUDIENCE_COPY.focus[f],
    recommended: f === RECOMMENDED.intent.audienceFocus,
  }));
  const size = s.c.value<AudienceSize | null>(sizeKey, view.easy.size === 'custom' ? null : view.easy.size);
  const focus = s.c.value<AudienceFocus | null>(focusKey, view.easy.focus === 'custom' ? null : view.easy.focus);
  return (
    <>
      <SeedField s={s} />
      <Sub>{AUDIENCE_COPY.size}</Sub>
      <RadioCards
        label={AUDIENCE_COPY.size}
        dataRow="audience.size"
        choices={sizes}
        selected={size}
        onSelect={(v) => s.send(sizeKey, [{ op: 'intent', key: 'audienceSize', value: v }], v)}
        pending={s.c.pending(sizeKey)}
      />
      {size === null ? <Custom s={s} /> : null}
      <ControlError s={s} k={sizeKey} />
      <p class="set-sec__hint">{AUDIENCE_COPY.sizeHint}</p>
      <Sub>{AUDIENCE_COPY.prefer}</Sub>
      <RadioCards
        class="radio-cards--two"
        label={AUDIENCE_COPY.prefer}
        dataRow="audience.focus"
        choices={focuses}
        selected={focus}
        onSelect={(v) => s.send(focusKey, [{ op: 'intent', key: 'audienceFocus', value: v }], v)}
        pending={s.c.pending(focusKey)}
      />
      {focus === null ? <Custom s={s} /> : null}
      <ControlError s={s} k={focusKey} />
      <SwitchRow
        label={AUDIENCE_COPY.private}
        help={AUDIENCE_COPY.preferHint}
        checked={s.c.value<boolean>(privKey, view.intent.preferPrivate)}
        onChange={(v) => s.send(privKey, [{ op: 'intent', key: 'preferPrivate', value: v }], v)}
        s={s}
        k={privKey}
        dataRow="preferPrivate"
      />
      <Sub>{AUDIENCE_COPY.requests}</Sub>
      <Requests s={s} />
    </>
  );
}
