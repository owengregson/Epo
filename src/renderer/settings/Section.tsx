import type { ComponentChildren, JSX } from 'preact';
import type { SectionId } from '@/shared/settings-params';
import { PROTECTION_COPY } from './copy/fields';
import { SECTION_COPY, STAGE_COPY } from './copy/sections';
import { fill } from './format';
import { sectionDomId } from './sections';
import type { StageApi } from './stage-api';

/** Param keys whose recommendation a section's "Use recommended" restores. */
function overriddenKeys(s: StageApi, section: SectionId) {
  return s.view.params.filter((p) => p.section === section && p.override !== null).map((p) => p.key);
}

/**
 * One Settings section: its heading and question, the body, and in Easy a note when values in it were
 * fine-tuned in Advanced ("Fine-tuned in Advanced (2) · Review · Use recommended").
 */
export function Section({ id, s, children }: { id: SectionId; s: StageApi; children?: ComponentChildren }): JSX.Element {
  const copy = SECTION_COPY[id];
  // Until protection guards every path, its lead promises only what is true: pruning keeps them.
  const question = id === 'protection' && !s.view.capabilities.protectionEverywhere
    ? PROTECTION_COPY.leadPartial : 'question' in copy ? copy.question : undefined;
  const tuned = s.view.overrides.bySection[id] ?? 0;
  const reset = (): void => {
    const keys = overriddenKeys(s, id);
    s.send(`reset:${id}`, keys.map((key) => ({ op: 'clear-override', key })));
  };
  return (
    <section class="set-sec" id={sectionDomId(id)} data-section={id} aria-labelledby={`${sectionDomId(id)}-h`}>
      <div class="set-sec__head">
        <h2 id={`${sectionDomId(id)}-h`}>{copy.title}</h2>
        {question === undefined ? null : <p>{question}</p>}
      </div>
      {s.mode === 'easy' && tuned > 0 ? (
        <p class="set-tuned">
          <span>{fill(STAGE_COPY.fineTuned, { n: tuned })}</span>
          <button type="button" class="link-btn" onClick={() => s.openAdvanced(id)}>
            {STAGE_COPY.review}
          </button>
          <button type="button" class="link-btn" onClick={reset}>
            {STAGE_COPY.useRecommended}
          </button>
        </p>
      ) : null}
      {children}
    </section>
  );
}
