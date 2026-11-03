import { computed, type ReadonlySignal, signal } from '@preact/signals';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { liveRevealedSignal, resetLiveSignals } from '@/renderer/app/live-signals';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import type { ToastKind } from '@/renderer/hooks/useToasts';
import { type TransportModel, transportModel } from '@/renderer/lib/engine-view';
import type { LogEntry } from '@/shared/log-entry';
import type { SettingsFacts } from '@/shared/settings-facts';
import type { SettingsView } from '@/shared/settings-view';
import type { StageMode } from '@/shared/stage-mode';
import type { EpoStatus, PruneStatus, Settings } from '@/types';

/**
 * The shell's published projections — the things it owns exactly once and
 * every page reads. Subscribing or fetching any of these a second time inside a
 * page lets two copies of one projection disagree, so they live here.
 *
 * They are SIGNALS, not context state (ADR 1004): the shell's hooks write
 * `.value`, and a component re-renders only if it READ the signal that changed,
 * so a push never re-renders the whole tree. The live feeds beyond status live
 * in `live-signals.ts`.
 */

/** The engine status projection (pushed on store mutation, never gated on completion). */
export const statusSignal = signal<EpoStatus | null>(null);
/** The prune projection; while a prune holds the tab it drives the console. */
export const pruneSignal = signal<PruneStatus | null>(null);
/** Canonical settings, loaded once by the shell. */
export const settingsSignal = signal<Settings | null>(null);
/** The Settings view (pushed after every persisted settings write). */
export const settingsViewSignal = signal<SettingsView | null>(null);
/** The store-derived Settings facts (a projection row; pushed on store mutation). */
export const settingsFactsSignal = signal<SettingsFacts | null>(null);

/** A log entry stamped with a feed-local sequence number (the stable render key). */
export interface LogLine extends LogEntry {
  seq: number;
}
/** Log lines for the console column's activity card (the raw log itself streams only to Diagnostics). */
export const logSignal = signal<LogLine[]>([]);

/** Which stage fills the window right of the console. */
export const stageSignal = signal<StageMode>('tab');
/** A renderer modal is open: the native views must not float above its scrim. */
export const modalSignal = signal(false);
/** True while the Instagram page is drawn over the Live stage (it covers x ≥ console, y ≥ stage bar). */
export const nativeViewSignal: ReadonlySignal<boolean> = computed(
  () => stageSignal.value === 'tab' && liveRevealedSignal.value && !modalSignal.value,
);

/** Where `openSettings` lands: a section, and a field to focus in it. */
export interface SettingsTarget {
  readonly section: string;
  readonly focus?: string;
}
/** The latest Settings destination (a fresh object per request), for the Settings stage to act on. */
export const settingsTargetSignal = signal<SettingsTarget | null>(null);

/**
 * The unified console posture derived from BOTH status channels.
 *
 * `transportModel` builds a fresh object per call, so the computed caches the
 * previous one whenever all fields match: a status push that does not change
 * the POSTURE wakes nothing while counts tick underneath.
 */
let lastTransport: TransportModel = { state: 'idle', driver: 'growth', pruneScanning: false };
export const transportSignal: ReadonlySignal<TransportModel> = computed(() => {
  const next = transportModel(statusSignal.value?.state, pruneSignal.value?.state, statusSignal.value?.runtime);
  const prev = lastTransport;
  if (
    next.state === prev.state &&
    next.driver === prev.driver &&
    next.pruneScanning === prev.pruneScanning &&
    next.intentActive === prev.intentActive
  ) {
    return prev;
  }
  lastTransport = next;
  return next;
});

/** Adopt a saved Settings object as the new canonical one. */
export function adoptSettings(next: Settings): void {
  settingsSignal.value = next;
}

/**
 * Drop every published projection back to its pre-boot state. Test-only: the
 * signals are module scope, so a second `render(<App/>)` in the same file would
 * otherwise paint the previous case's projections before the first pull lands.
 */
export function resetShellSignals(): void {
  statusSignal.value = null;
  pruneSignal.value = null;
  settingsSignal.value = null;
  logSignal.value = [];
  settingsViewSignal.value = null;
  settingsFactsSignal.value = null;
  stageSignal.value = 'tab';
  modalSignal.value = false;
  settingsTargetSignal.value = null;
  resetLiveSignals();
  lastTransport = { state: 'idle', driver: 'growth', pruneScanning: false };
}

/** The shell's two services — per-App closures, so context rather than signals. */
export interface ShellServices {
  /** The one confirmation modal; resolves true on confirm. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The shell's toast pusher — every typed failure surfaces through it. */
  toast(kind: ToastKind, message: string): void;
}

/**
 * The shell's controls (spec §12.4, §13): stages, the Settings destination and
 * the one runner behind Start / Pause / Stop / Sign in. A context of their own,
 * read with `useShellControls()`, so a page that only needs the two services
 * (and the tests that provide them) stays as it was.
 */
export interface ShellControls {
  /** Show a stage. */
  showStage(mode: StageMode): void;
  /** Open the Settings stage, at a section and field when given. */
  openSettings(target?: SettingsTarget): void;
  /** Start Epo, or open Settings at the starting account when none is chosen yet. */
  start(): void;
  /** Pause or resume whichever driver holds the page. */
  pauseResume(): void;
  /** Stop whichever driver holds the page. */
  stop(): Promise<void>;
  /** Show Instagram on the Live stage, then sign in there. */
  signIn(): void;
  /** Open the intro tour again. */
  replayTour(): void;
}

/** What `useShell()` hands a page: the projections plus the services. */
export interface Shell extends ShellServices {
  status: EpoStatus | null;
  prune: PruneStatus | null;
  settings: Settings | null;
  /** Adopt a saved Settings object as the new canonical one. */
  onSaved(next: Settings): void;
}

const MISSING = (): never => {
  throw new Error('useShell() used outside <ShellContext.Provider>');
};

export const ShellContext = createContext<ShellServices>({ confirm: MISSING, toast: MISSING });

export const ShellControlsContext = createContext<ShellControls>({
  showStage: MISSING,
  openSettings: MISSING,
  start: MISSING,
  pauseResume: MISSING,
  stop: MISSING,
  signIn: MISSING,
  replayTour: MISSING,
});

/** The shell's controls (stable per App, so reading them re-renders nothing). */
export function useShellControls(): ShellControls {
  return useContext(ShellControlsContext);
}

/**
 * Read the shell's shared projections and services.
 *
 * The projections are GETTERS on purpose: destructuring `const { settings } =
 * useShell()` reads exactly one signal, so that component subscribes to exactly
 * one signal.
 */
export function useShell(): Shell {
  const services = useContext(ShellContext);
  return {
    get status() {
      return statusSignal.value;
    },
    get prune() {
      return pruneSignal.value;
    },
    get settings() {
      return settingsSignal.value;
    },
    onSaved: adoptSettings,
    confirm: services.confirm,
    toast: services.toast,
  };
}
