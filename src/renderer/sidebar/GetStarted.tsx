/**
 * Get started (spec §12.2): on a first run the three steps replace Today and Results, each checking off live
 * as it happens — sign in, choose a starting account, press Start.
 */
import type { JSX } from 'preact';
import { statusSignal, useShellControls } from '@/renderer/app/shell-context';
import { SEED_TARGET } from '@/renderer/app/shell-services';
import { GET_STARTED } from '@/renderer/sidebar/copy/zone-copy';
import { postureInputSignal } from '@/renderer/sidebar/posture-signal';
import { Icon } from '@/renderer/ui/Icon';

export function GetStarted({ started }: { started: boolean }): JSX.Element {
  const status = statusSignal.value;
  const controls = useShellControls();
  const signedIn = status?.loggedIn === true;
  const seeded = postureInputSignal.value.seedSet;
  const steps = [
    { key: 'sign-in', label: GET_STARTED.signIn, done: signedIn },
    { key: 'seed', label: GET_STARTED.seed, done: seeded },
    { key: 'start', label: GET_STARTED.start, done: started },
  ];
  const done = steps.filter((s) => s.done).length;
  const current = steps.find((s) => !s.done)?.key ?? null;
  return (
    <section class="sb-zone sb-start" data-zone="get-started" data-tour="today results">
      <div class="sb-start__title">
        <h3>{GET_STARTED.title}</h3>
        <span class="num">{GET_STARTED.progress(done, steps.length)}</span>
      </div>
      <div class="sb-start__bar" aria-hidden="true">
        <i style={{ transform: `scaleX(${done / steps.length})` }} />
      </div>
      <ol>
        {steps.map((s) => (
          <li key={s.key} class={s.done ? 'is-done' : s.key === current ? 'is-now' : undefined}>
            <span class="sb-start__tick">{s.done ? <Icon name="check" /> : null}</span>
            <span class="sb-start__label">{s.label}</span>
            {s.key === 'seed' && !s.done ? (
              <button type="button" class="sb-btn sb-btn--small" onClick={() => controls.openSettings(SEED_TARGET)}>
                {GET_STARTED.choose} <Icon name="arrow-right-long" />
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
