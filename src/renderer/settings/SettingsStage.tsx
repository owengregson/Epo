import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { settingsTargetSignal, stageSignal, statusSignal, useShell } from '@/renderer/app/shell-context';
import { type SettingsCommit, useSettingsCommit } from '@/renderer/hooks/useSettingsCommit';
import { useSettingsFacts } from '@/renderer/hooks/useSettingsFacts';
import { useSettingsView } from '@/renderer/hooks/useSettingsView';
import type { SettingsOp } from '@/shared/settings-ops';
import type { SectionId } from '@/shared/settings-params';
import type { SettingsView } from '@/shared/settings-view';
import type { UpdateStatus } from '@/shared/update-status';
import { FineTune } from './advanced/FineTune';
import { atLimitGate } from './at-limit';
import { STAGE_COPY } from './copy/sections';
import { ExpectPanel, SummaryLine } from './ExpectPanel';
import { Notices } from './Notices';
import { Section } from './Section';
import { SectionRail } from './SectionRail';
import { SettingsHeader, saveStatusOf } from './SettingsHeader';
import { SettingsSearch } from './SettingsSearch';
import { useScrollSpy } from './scroll-spy';
import { ADVANCED_EXTRAS, SECTION_BODIES } from './section-bodies';
import { isAdvancedOnly, type SettingsMode, sectionDomId, sectionOf, visibleSections } from './sections';
import type { StageApi } from './stage-api';

export interface SettingsStageProps {
  /** The updater's state, owned by the shell (the Practice & app section shows it honestly). */
  updateStatus?: UpdateStatus | null;
  /** @deprecated interim props the old stage read; ignored (deep links ride `settingsTargetSignal`). */
  goTo?: (view: 'overview' | 'chain' | 'queues' | 'settings') => void;
  seedPrompt?: number;
  onReplayTour?: () => void;
}

/** Scroll a row (or its section) into view and give it a brief highlight. */
function reveal(section: SectionId, row?: string): void {
  const el = (row ? document.querySelector<HTMLElement>(`[data-row="${row}"]`) : null) ?? document.getElementById(sectionDomId(section));
  el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  if (row && el) {
    el.classList.remove('is-found');
    void el.offsetWidth;
    el.classList.add('is-found');
  }
}

function Stage({ view, c, updateStatus }: { view: SettingsView; c: SettingsCommit; updateStatus: UpdateStatus | null }): JSX.Element {
  const { confirm, toast } = useShell();
  const facts = useSettingsFacts();
  const status = statusSignal.value;
  const mode = c.value<SettingsMode>('ui:mode', view.mode);
  const sections = visibleSections(view, mode);
  const content = useRef<HTMLElement>(null);
  const active = useScrollSpy(content, sections);
  const [pendingReveal, setPendingReveal] = useState<{ section: SectionId; row?: string } | null>(null);

  const send = useCallback(
    (key: string, ops: readonly SettingsOp[], shown?: unknown) => {
      void atLimitGate(view, ops, confirm).then((go) => {
        if (go) c.commit(key, ops, shown);
      });
    },
    [view, c, confirm],
  );
  const setMode = useCallback((m: SettingsMode) => c.commit('ui:mode', [{ op: 'ui', mode: m }], m), [c]);

  const api = useMemo<StageApi>(
    () => ({
      view, facts, c, mode, status, updateStatus, confirm, toast, send,
      scrollTo: (section, row) => reveal(section, row),
      openAdvanced: (section, row) => {
        if (mode === 'easy') {
          setMode('advanced');
          setPendingReveal({ section, row });
        } else reveal(section, row);
      },
    }),
    [view, facts, c, mode, status, updateStatus, confirm, toast, send, setMode],
  );

  // A section that only exists in Advanced is revealed once the mode switch has rendered it.
  useEffect(() => {
    if (pendingReveal === null || !sections.includes(pendingReveal.section)) return;
    reveal(pendingReveal.section, pendingReveal.row);
    setPendingReveal(null);
  }, [pendingReveal, sections]);

  // Deep links (Start without a starting account, a tour step): every request is a fresh object.
  const target = settingsTargetSignal.value;
  useEffect(() => {
    if (target === null || stageSignal.peek() !== 'settings') return;
    const section = sectionOf(target.section, view);
    if (section === null) return;
    if (isAdvancedOnly(section) && mode === 'easy') api.openAdvanced(section);
    else reveal(section);
    if (target.focus) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-focus="${target.focus}"]`)?.focus());
    }
  }, [target]);

  return (
    <div class="stage-page set-page" data-mode={mode}>
      <SettingsHeader mode={mode} onMode={setMode} save={saveStatusOf(c.state, c.undo, c.retry)} search={<SettingsSearch s={api} />} />
      <Notices s={api} />
      <SummaryLine status={status} />
      <div class="set-grid">
        <SectionRail view={view} sections={sections} active={active} onPick={(id) => reveal(id)} />
        <main class="set-content" ref={content}>
          {sections.map((id) => {
            const Body = SECTION_BODIES[id];
            const Extra = ADVANCED_EXTRAS[id];
            return (
              <Section key={id} id={id} s={api}>
                <Body s={api} />
                {mode === 'advanced' && !isAdvancedOnly(id) ? (
                  <FineTune s={api} section={id} extra={Extra ? <Extra s={api} /> : undefined} />
                ) : null}
              </Section>
            );
          })}
        </main>
        <ExpectPanel view={view} status={status} mode={mode} />
      </div>
    </div>
  );
}

/**
 * The Settings stage (spec §6.4–§6.8, ADR 1011): Easy and Advanced over the view main computes, every
 * change through the one change queue. Mounted lazily, so nothing on it runs at launch.
 */
export function SettingsStage({ updateStatus = null }: SettingsStageProps): JSX.Element {
  const load = useSettingsView();
  const c = useSettingsCommit(load.view);
  if (c.view === null) {
    return (
      <div class="stage-page set-page set-page--empty" role={load.failed ? 'alert' : 'status'}>
        <h1>{STAGE_COPY.title}</h1>
        {load.failed ? (
          <p>
            {STAGE_COPY.loadFailed}{' '}
            <button type="button" class="link-btn" onClick={load.retry}>
              {STAGE_COPY.retry}
            </button>
          </p>
        ) : (
          <p>{STAGE_COPY.loading}</p>
        )}
      </div>
    );
  }
  return <Stage view={c.view} c={c} updateStatus={updateStatus} />;
}
