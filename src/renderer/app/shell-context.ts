import { computed, type ReadonlySignal, signal } from '@preact/signals';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import type { LogLine } from '@/renderer/hooks/useLogFeed';
import type { ToastKind } from '@/renderer/hooks/useToasts';
import { type TransportModel, transportModel } from '@/renderer/lib/engine-view';
import type { EpoStatus, PruneStatus, Settings } from '@/types';

/**
 * The shell's published projections — the four things it owns exactly once and
 * every view reads. Subscribing or fetching any of these a second time inside a
 * view lets two copies of one projection disagree, so they live here.
 *
 * They are SIGNALS, not context state (ADR 1004). The subscription plumbing is
 * unchanged — push-first with a keep-alive pull backstop (docs/PRINCIPLES.md
 * §2) — only the sink moved: `useKeepAlivePoll` writes `.value` instead of
 * calling `setState` on the shell. That is what stops a streamed log line (or a
 * status push during a scan) from re-rendering the entire tree: a component
 * re-renders only if it READ the signal that changed.
 */

/** The engine status projection (pushed on store mutation, never gated on completion). */
export const statusSignal = signal<EpoStatus | null>(null);
/** The prune projection; while a prune holds the tab it drives the console. */
export const pruneSignal = signal<PruneStatus | null>(null);
/** Canonical settings, loaded once by the shell. */
export const settingsSignal = signal<Settings | null>(null);
/** The streamed structured log, capped by the feed's ring buffer. */
export const logSignal = signal<LogLine[]>([]);

/**
 * The unified console posture derived from BOTH status channels.
 *
 * `transportModel` builds a fresh object per call, so the computed caches the
 * previous one whenever all three fields match. That referential stability is
 * load-bearing: it means a status push that does not change the POSTURE wakes
 * nothing — the console's `data-state`, the transport trio and the routing all
 * stay put while counts tick underneath.
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

/** The most recent streamed line, or null before anything has streamed. */
export const latestLogSignal: ReadonlySignal<LogLine | null> = computed(() => {
  const lines = logSignal.value;
  return lines.length > 0 ? (lines[lines.length - 1] as LogLine) : null;
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
  lastTransport = { state: 'idle', driver: 'growth', pruneScanning: false };
}

/** The two shell-level services — per-App closures, so not signals. */
export interface ShellServices {
  /** The one confirmation modal; resolves true on confirm. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The shell's toast pusher — every typed failure surfaces through it. */
  toast(kind: ToastKind, message: string): void;
}

/** What `useShell()` hands a view: the four projections plus the two services. */
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

export const ShellContext = createContext<ShellServices>({
  confirm: MISSING,
  toast: MISSING,
});

/**
 * Read the shell's shared projections and services.
 *
 * The projections are GETTERS on purpose: destructuring `const { settings } =
 * useShell()` reads exactly one signal, so that component subscribes to exactly
 * one signal. Reading the whole object eagerly would re-subscribe every
 * consumer to every push — the very churn ADR 0403 left on the table.
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
