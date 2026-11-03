import type { JSX } from 'preact';
import { Icon } from '@/renderer/ui/Icon';
import type { SectionId } from '@/shared/settings-params';
import type { SettingsView } from '@/shared/settings-view';
import { SECTION_COPY, STAGE_COPY } from './copy/sections';
import { fill } from './format';
import { isAdvancedOnly } from './sections';

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

function Item({ id, p, chip }: { id: SectionId; p: SectionRailProps; chip: boolean }): JSX.Element {
  const on = id === p.active;
  return (
    <button
      type="button"
      class={chip ? (on ? 'set-chip is-on' : 'set-chip') : on ? 'is-on' : undefined}
      aria-current={on ? 'true' : undefined}
      onClick={() => p.onPick(id)}
    >
      {chip ? null : <Icon name={SECTION_COPY[id].icon} />}
      <span>{SECTION_COPY[id].title}</span>
      <Dot view={p.view} id={id} />
    </button>
  );
}

/**
 * The section list: a rail beside the content on a wide stage, wrapping chips above it on a narrow one
 * (CSS picks by the stage's width, so every section stays in view and nothing scrolls sideways). The
 * current section is marked as you scroll.
 */
export function SectionRail(p: SectionRailProps): JSX.Element {
  const easy = p.sections.filter((s) => !isAdvancedOnly(s));
  const advanced = p.sections.filter(isAdvancedOnly);
  const list = (chip: boolean): JSX.Element => (
    <>
      {easy.map((id) => <Item key={id} id={id} p={p} chip={chip} />)}
      {advanced.length > 0 ? <span class={chip ? 'set-chips__sep' : 'set-rail__sep'}>{STAGE_COPY.advancedRail}</span> : null}
      {advanced.map((id) => <Item key={id} id={id} p={p} chip={chip} />)}
    </>
  );
  return (
    <>
      <nav class="set-rail" aria-label="Settings sections">
        {list(false)}
      </nav>
      <nav class="set-chips" aria-label="Settings sections">
        {list(true)}
      </nav>
    </>
  );
}
