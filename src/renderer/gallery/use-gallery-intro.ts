import { useEffect, useRef, useState } from 'preact/hooks';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { appRevealedSignal } from '@/renderer/boot/BootGate';
import { playIntro } from '@/renderer/boot/intro';

/** Replay the real launch motion over fixture data, without waiting for a main process. */
export function useGalleryIntro(): { replay(): void; playing: boolean } {
  const template = useRef<HTMLElement | null>(null);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const splash = document.getElementById('boot') ?? template.current?.cloneNode(true) as HTMLElement | null;
    if (splash == null) {
      setPlaying(false);
      return;
    }
    if (template.current === null) template.current = splash.cloneNode(true) as HTMLElement;
    if (!splash.isConnected) document.body.append(splash);
    appRevealedSignal.value = false;
    let active = true;
    const uncover = (): void => {
      splash.remove();
      appRevealedSignal.value = true;
    };
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (!active) return;
      return playIntro(splash, reducedMotionSignal.peek(), {
        handoff: uncover,
        live: () => {},
        revealed: () => { if (active) setPlaying(false); },
      });
    });
    return () => { active = false; uncover(); };
  }, [playing]);

  return { replay: () => setPlaying(true), playing };
}
