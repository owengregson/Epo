/**
 * The Now zone's controls (spec §12.2, §12.3): one posture-derived primary button and Stop (or Start beside
 * an attention action). During a prune the same buttons drive the prune. While a control is on its way the
 * buttons wait with their label, never a spinner.
 */
import type { JSX } from 'preact';
import { pendingControlSignal } from '@/renderer/app/live-signals';
import { useShellControls } from '@/renderer/app/shell-context';
import { SEED_TARGET } from '@/renderer/app/shell-services';
import { PRIMARY_FACE, SECONDARY_LABEL } from '@/renderer/sidebar/copy/posture-copy';
import { Icon } from '@/renderer/ui/Icon';
import type { Posture, PrimaryControl } from '@/shared/posture';

type Controls = ReturnType<typeof useShellControls>;

function pressPrimary(c: Controls, primary: NonNullable<PrimaryControl>): void {
  switch (primary) {
    case 'start': c.start(); break;
    case 'starting': break;
    case 'pause': case 'resume': case 'pause-cleanup': case 'resume-cleanup': c.pauseResume(); break;
    case 'sign-in': c.signIn(); break;
    case 'set-up': case 'choose-seed': c.openSettings(SEED_TARGET); break;
    case 'show-live': c.showStage('tab'); break;
    case 'check-update': void window.epo.checkForUpdate(); break;
    case 'open-prune': c.showStage('prune'); break;
    case 'diagnostics': c.openSettings({ section: 'diagnostics' }); break;
  }
}

export function TransportRow({ posture }: { posture: Posture }): JSX.Element {
  const controls = useShellControls();
  const pending = pendingControlSignal.value;
  const { primary, secondary } = posture;
  const face = primary === null ? null : PRIMARY_FACE[primary];
  return (
    <div class="sb-now__buttons">
      {primary !== null && face !== null ? (
        <button
          type="button"
          class="sb-btn sb-btn--primary"
          data-control={primary}
          disabled={primary === 'starting' || pending !== null}
          aria-busy={pending !== null && pending !== 'stop' ? 'true' : undefined}
          onClick={() => pressPrimary(controls, primary)}
        >
          <Icon name={face.icon} brand={face.brand} />
          {face.label}
        </button>
      ) : null}
      {secondary !== null ? (
        <button
          type="button"
          class={primary === null ? 'sb-btn sb-btn--primary' : 'sb-btn sb-btn--ghost'}
          data-control={secondary}
          disabled={pending === 'stop'}
          onClick={() => (secondary === 'start' ? controls.start() : void controls.stop())}
        >
          {SECONDARY_LABEL[secondary]}
        </button>
      ) : null}
    </div>
  );
}
