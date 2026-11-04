import type { JSX } from 'preact';
import type { ParamKey } from '@/shared/settings-params';
import type { ProvenanceStep, SettingsView } from '@/shared/settings-view';
import { labelOf, valueWord } from '../choice-words';
import { PROVENANCE_COPY } from '../copy/advanced';
import { PARAM_COPY } from '../copy/params';
import { fill } from '../format';

/** One step of a recommendation's chain, in words (the numbers are main's). */
function step(st: ProvenanceStep, view: SettingsView): string {
  switch (st.kind) {
    case 'choice': return fill(PROVENANCE_COPY.choice, { v: valueWord(st.intent, st.value, view), k: labelOf(st.intent) });
    case 'param': return fill(PROVENANCE_COPY.param, { k: PARAM_COPY[st.key as ParamKey].label, v: valueWord(st.key, st.value, view) });
    case 'policy': return fill(PROVENANCE_COPY.policy, { k: st.key, v: String(st.value) });
    case 'fundamental': return fill(PROVENANCE_COPY.fundamental, { k: st.key, v: String(st.value), unit: st.unit, rev: st.rev });
    case 'op': return PROVENANCE_COPY[st.op];
  }
}

/** "Why this number?": where a recommendation comes from, step by step (spec §6.5). */
export function Provenance({ steps, view }: { steps: readonly ProvenanceStep[]; view: SettingsView }): JSX.Element {
  return (
    <ol class="set-prov num">
      {steps.map((st, i) => (
        <li key={`${i}-${st.kind}`}>{step(st, view)}</li>
      ))}
    </ol>
  );
}
