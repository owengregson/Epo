/**
 * The launch gate (spec §12.8): the app renders under the inline splash (`#boot` in index.html) while main
 * opens the data and lands on the profile behind it. Once readiness holds — main's boot ready, the first
 * frame's data here, Instagram decided (R4 ∧ R5), the fonts loaded and the splash's shortest dwell passed —
 * or main's reveal deadline passes, the intro plays into the preloaded app and main hears `bootRevealed()`
 * once. A renderer reload (main already live) skips the intro. Until the reveal the native page stays
 * covered; after it, Instagram shows once its first load settled, else the Live placeholder does.
 */
import { computed, signal } from '@preact/signals';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  chainListSignal, feedSignal, growthSeriesSignal, liveRevealedSignal, liveSlotSignal, queueLanesSignal,
} from '@/renderer/app/live-signals';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { pruneSignal, settingsFactsSignal, settingsViewSignal, statusSignal } from '@/renderer/app/shell-context';
import { splashCaption } from '@/renderer/boot/boot-copy';
import { playIntro } from '@/renderer/boot/intro';
import { LivePlaceholder } from '@/renderer/boot/LivePlaceholder';
import { BOOT_UI } from '@/renderer/design/motion-scale';

/** True once the app is on screen (the splash gone): the tour waits for it. True where no gate holds it. */
export const appRevealedSignal = signal(true);

/** R4's data half: what the first frame shows has arrived (pushes or the shell's pulls). */
const preloadedSignal = computed(
  () =>
    pruneSignal.value !== null && settingsViewSignal.value !== null && settingsFactsSignal.value !== null
    && feedSignal.value !== null && chainListSignal.value !== null && growthSeriesSignal.value !== null
    && queueLanesSignal.value !== null,
);

/** Where main's boot stands: not heard yet, still starting, ready to reveal, or already live (a reload). */
const bootStageSignal = computed((): 'unknown' | 'waiting' | 'ready' | 'live' => {
  const s = statusSignal.value;
  if (s === null) return 'unknown';
  const boot = s.boot;
  // A status without a boot view has nothing to wait for (main tracks no launch).
  if (boot == null || boot.phase === 'live') return 'live';
  if (boot.phase === 'starting' || boot.ig === 'pending') return 'waiting';
  const data = s.basis === 'built' || boot.identity === 'signed-out' || boot.data === 'unavailable';
  return data && preloadedSignal.value ? 'ready' : 'waiting';
});

const splashEl = (): HTMLElement | null => document.getElementById('boot');

/** The fonts the first frame uses have loaded (jsdom has no font loading: nothing to wait for). */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(() => typeof document.fonts?.ready?.then !== 'function');
  useEffect(() => {
    if (!ready) void document.fonts.ready.then(() => setReady(true));
  }, [ready]);
  return ready;
}

/** Milliseconds since the gate mounted, re-rendering at each splash moment that changes what it shows. */
function useSplashClock(running: boolean): number {
  const [t0] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timers = [BOOT_UI.MIN_SPLASH_MS, BOOT_UI.CAPTION_DELAY_MS, BOOT_UI.SLOW_COPY_MS].map((ms) =>
      setTimeout(() => tick((n) => n + 1), Math.max(0, ms - (Date.now() - t0))),
    );
    return () => timers.forEach(clearTimeout);
  }, [running, t0]);
  return Date.now() - t0;
}

export function BootGate({ children }: { children: ComponentChildren }): JSX.Element {
  // Before the first render (and so before the shell's first stage request): the page stays covered.
  useState(() => {
    appRevealedSignal.value = false;
    liveRevealedSignal.value = false;
    liveSlotSignal.value = <LivePlaceholder />;
    return true;
  });
  const [phase, setPhase] = useState<'splash' | 'intro' | 'done'>('splash');
  const [liveGate, setLiveGate] = useState(false);
  const told = useRef(false);
  const stage = bootStageSignal.value;
  const fonts = useFontsReady();
  const elapsed = useSplashClock(phase === 'splash');
  const [late, setLate] = useState(false);
  const revealBy = statusSignal.value?.boot?.revealBy ?? null;
  const tab = statusSignal.value?.boot?.tab ?? 'settled';

  // Main's reveal deadline: past it the app shows anyway, with skeletons or the Live placeholder.
  useEffect(() => {
    if (phase !== 'splash' || revealBy === null) return;
    const timer = setTimeout(() => setLate(true), Math.max(0, revealBy - Date.now()));
    return () => clearTimeout(timer);
  }, [phase, revealBy]);

  // The caption says what the splash waits for, once its delay has passed.
  useEffect(() => {
    const caption = document.getElementById('boot-caption');
    if (caption === null || phase !== 'splash') return;
    const s = statusSignal.peek();
    caption.textContent = splashCaption(s?.boot ?? null, elapsed, {
      caption: BOOT_UI.CAPTION_DELAY_MS, slow: BOOT_UI.SLOW_COPY_MS,
    });
  });

  useEffect(() => {
    if (phase !== 'splash' || stage === 'unknown') return;
    const finish = (): void => {
      splashEl()?.remove();
      appRevealedSignal.value = true;
    };
    if (stage === 'live') {
      // A reload: main is already live, so there is no intro and nothing to tell it.
      told.current = true;
      finish();
      setLiveGate(true);
      setPhase('done');
      return;
    }
    const dwelt = elapsed >= BOOT_UI.MIN_SPLASH_MS;
    if (!late && !(stage === 'ready' && fonts && dwelt)) return;
    setPhase('intro');
    const splash = splashEl();
    const hooks = {
      handoff: finish,
      live: () => setLiveGate(true),
      revealed: () => {
        if (!told.current) {
          told.current = true;
          void window.epo.bootRevealed();
        }
        setPhase('done');
      },
    };
    if (splash === null) {
      hooks.handoff();
      hooks.live();
      hooks.revealed();
      return;
    }
    void playIntro(splash, reducedMotionSignal.peek(), hooks);
  }, [phase, stage, fonts, elapsed, late]);

  // Instagram shows once the gate opened Live and its first load settled; until then the placeholder does.
  useEffect(() => {
    liveRevealedSignal.value = liveGate && tab === 'settled';
  }, [liveGate, tab]);

  return <>{children}</>;
}
