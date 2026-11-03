import { useEffect, useMemo } from 'preact/hooks';
import { liveRevealedSignal, pendingControlSignal } from '@/renderer/app/live-signals';
import {
  modalSignal,
  type SettingsTarget,
  type ShellControls,
  settingsFactsSignal,
  settingsSignal,
  settingsTargetSignal,
  stageSignal,
} from '@/renderer/app/shell-context';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import type { ControlRunner } from '@/renderer/hooks/useControl';
import { useTransportControls } from '@/renderer/hooks/useTransportControls';
import type { StageMode } from '@/shared/stage-mode';

/** Where Start sends someone who has not chosen a starting account yet (spec §13). */
export const SEED_TARGET: SettingsTarget = { section: 'audience', focus: 'seed' };

export function showStage(mode: StageMode): void {
  stageSignal.value = mode;
}

/** Each request is a fresh object, so asking for the same field twice still reaches the stage. */
export function openSettings(target?: SettingsTarget): void {
  settingsTargetSignal.value = target === undefined ? null : { ...target };
  showStage('settings');
}

/** Whether the native views must stay covered right now (a modal, or before the boot reveal). */
export function coveredNow(): boolean {
  return modalSignal.peek() || !liveRevealedSignal.peek();
}

/** A starting account is chosen: from the store-derived facts once built, else the settings the shell loaded. */
export function hasSeed(): boolean {
  const facts = settingsFactsSignal.peek();
  if (facts?.built) return facts.seed.kind !== 'none';
  return Boolean(settingsSignal.peek()?.seed?.trim());
}

/** The control runner's names, as the posture's pending input. */
const PENDING: Readonly<Record<string, 'start' | 'pause' | 'stop'>> = {
  start: 'start',
  pauseResume: 'pause',
  stop: 'stop',
};

/** After a stop the page stays where it is: the console column already shows the new state. */
const STAY = (): void => undefined;

export interface ShellControlDeps {
  confirm(options: ConfirmOptions): Promise<boolean>;
  control: ControlRunner;
  replayTour(): void;
}

/**
 * The controls every page reaches through `useShellControls()`: one control
 * runner for Start / Pause / Stop / Sign in (its in-flight name mirrored on
 * `pendingControlSignal`), stage switching, and the Settings destination.
 * Stable while its inputs are, so the context never re-renders its consumers.
 */
export function useProvideShellControls({ confirm, control, replayTour }: ShellControlDeps): ShellControls {
  const { run, pending } = control;
  const { onPauseResume, onCancel, onLogin } = useTransportControls(control, confirm, STAY);

  useEffect(() => {
    pendingControlSignal.value = pending === null ? null : (PENDING[pending] ?? null);
  }, [pending]);

  return useMemo<ShellControls>(
    () => ({
      showStage,
      openSettings,
      replayTour,
      start() {
        // Read at press time: the services never subscribe to settings just to know this.
        if (!hasSeed()) {
          openSettings(SEED_TARGET);
          return;
        }
        void run('start', 'Start', () => window.epo.startEngine());
      },
      pauseResume: onPauseResume,
      stop: onCancel,
      signIn() {
        // Main no longer shows the tab on login: the Live stage is asked for first.
        showStage('tab');
        void window.epo.setStage('tab', coveredNow());
        onLogin();
      },
    }),
    [replayTour, run, onPauseResume, onCancel, onLogin],
  );
}
