/**
 * Practice & app (spec §6.4): practice mode (turning it off asks first), the updater's honest state, the
 * intro again, Reset to recommended (a sheet with main's own diff), and Clear data & log out. Advanced adds
 * "Start over from the older version's settings".
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useShellControls } from '@/renderer/app/shell-context';
import { CompatibilityLine } from '@/renderer/settings/compatibility/CompatibilityLine';
import { APP_COPY } from '../copy/choices';
import { SwitchRow } from '../fields/controls';
import { ResetConfirm } from '../fields/ResetConfirm';
import { UpdatesRow } from '../fields/UpdatesRow';
import type { SectionProps, StageApi } from '../stage-api';

const PRACTICE_KEY = 'pref:practice';

function Practice({ s }: { s: StageApi }): JSX.Element {
  const on = s.c.value<boolean>(PRACTICE_KEY, s.view.prefs.practice);
  const set = async (next: boolean): Promise<void> => {
    if (!next) {
      const ok = await s.confirm({
        title: APP_COPY.practiceOffTitle, body: APP_COPY.practiceOff, confirm: APP_COPY.practiceOffYes, dismiss: APP_COPY.practiceOffNo,
      });
      if (!ok) return;
    }
    s.send(PRACTICE_KEY, [{ op: 'pref', key: 'practice', value: next }], next);
  };
  return (
    <SwitchRow
      label={APP_COPY.practice}
      help={APP_COPY.practiceHelp}
      checked={on}
      onChange={(v) => void set(v)}
      s={s}
      k={PRACTICE_KEY}
      dataRow="practice"
    />
  );
}

function ClearData({ s }: { s: StageApi }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const clear = async (): Promise<void> => {
    const ok = await s.confirm({
      title: APP_COPY.clearTitle, body: APP_COPY.clearBody, confirm: APP_COPY.clearYes, dismiss: APP_COPY.cancel, danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await window.epo.clearData();
    } catch {
      s.toast('error', APP_COPY.clearFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="set-row set-row--stack" data-row="clearData">
      <span class="set-row__k">{APP_COPY.clear}</span>
      <p class="set-sec__hint">{APP_COPY.clearHelp}</p>
      <button type="button" class="set-btn set-btn--danger" disabled={busy} onClick={() => void clear()}>
        {APP_COPY.clear}
      </button>
    </div>
  );
}

export function AppSection({ s }: SectionProps): JSX.Element {
  const { replayTour } = useShellControls();
  const [resetting, setResetting] = useState(false);
  return (
    <>
      <Practice s={s} />
      <UpdatesRow s={s} />
      <div class="set-row" data-row="replayTour">
        <span class="set-row__k set-row__k--wide">{APP_COPY.replay}</span>
        <button type="button" class="set-btn" onClick={replayTour}>
          {APP_COPY.replayButton}
        </button>
      </div>
      <div class="set-row set-row--stack" data-row="reset">
        <div class="set-row__line">
          <span class="set-row__k set-row__k--wide">{APP_COPY.reset}</span>
          <button type="button" class="set-btn" aria-expanded={resetting} onClick={() => setResetting(true)}>
            {APP_COPY.resetButton}
          </button>
        </div>
        {resetting ? <ResetConfirm s={s} onClose={() => setResetting(false)} /> : null}
      </div>
      <ClearData s={s} />
      {s.mode === 'easy' ? <CompatibilityLine onDetails={() => s.openAdvanced('diagnostics')} /> : null}
    </>
  );
}
