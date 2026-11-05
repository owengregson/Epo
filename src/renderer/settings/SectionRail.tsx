import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import type { SectionId } from '@/shared/settings-params';
import type { SettingsView } from '@/shared/settings-view';
import { SECTION_COPY, STAGE_COPY } from './copy/sections';
import { fill } from './format';
import { isAdvancedOnly, sectionDomId } from './sections';

export interface SectionRailProps {
  view: SettingsView;
  sections: readonly SectionId[];
  active: SectionId | null;
  onPick(section: SectionId): void;
}

/** A section's dot: values in it set by you (provenance, drawn neutral — never a warning colour). */
function Dot({ view, id }: { view: SettingsView; id: SectionId }): JSX.Element | null {
  const n = view.overrides.bySection[id] ?? 0;
  if (n === 0) return null;
  const label = fill(STAGE_COPY.setByYou, { n });
  return <i class="set-rail__dot" title={label} aria-label={label} />;
}

function Item({ id, p }: { id: SectionId; p: SectionRailProps }): JSX.Element {
  const on = id === p.active;
  return (
    <button
      type="button"
      class={on ? 'is-on' : undefined}
      aria-current={on ? 'true' : undefined}
      aria-controls={sectionDomId(id)}
      onClick={() => p.onPick(id)}
    >
      <span>{SECTION_COPY[id].title}</span>
      <Dot view={p.view} id={id} />
    </button>
  );
}

/**
 * Wide content gets plain navigation rows; narrow content gets one native section selector.
 * Both follow the current section as you scroll, without a tall block of wrapping category chips.
 */
export function SectionRail(p: SectionRailProps): JSX.Element {
  const selectId = useId();
  const easy = p.sections.filter((s) => !isAdvancedOnly(s));
  const advanced = p.sections.filter(isAdvancedOnly);
  const options = (ids: readonly SectionId[]) => ids.map((id) => <option key={id} value={id}>{SECTION_COPY[id].title}</option>);
  return (
    <nav class="set-rail" aria-label="Settings sections">
      <div class="set-rail__compact">
        <label for={selectId}>{STAGE_COPY.jumpToSection}</label>
        <select id={selectId} value={p.active ?? p.sections[0]} onChange={(e) => p.onPick(e.currentTarget.value as SectionId)}>
          {options(easy)}
          {advanced.length > 0 ? <optgroup label={STAGE_COPY.advancedRail}>{options(advanced)}</optgroup> : null}
        </select>
      </div>
      <div class="set-rail__list">
        <p class="set-rail__heading">{STAGE_COPY.sections}</p>
        {easy.map((id) => <Item key={id} id={id} p={p} />)}
        {advanced.length > 0 ? <p class="set-rail__sep">{STAGE_COPY.advancedRail}</p> : null}
        {advanced.map((id) => <Item key={id} id={id} p={p} />)}
      </div>
    </nav>
  );
}
