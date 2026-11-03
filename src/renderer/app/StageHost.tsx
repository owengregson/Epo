import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { staggerCards } from '@/renderer/lib/stagger';
import type { StageMode } from '@/shared/stage-mode';

/**
 * When a stage's page first mounts (spec §12.4): `eager` from the first render
 * (Graph lays out behind the splash); `on-activation` the first time it is
 * shown, rendering at once from data the shell fetched before the reveal
 * (People, Prune); `lazy` the first time it is shown, with nothing preloaded
 * beyond its pushes (Settings — so nothing on it runs at boot). Once mounted, a
 * page stays mounted: its state survives switching stages.
 */
export type StageMount = 'eager' | 'on-activation' | 'lazy';

export interface StageHostProps {
  mode: StageMode;
  active: boolean;
  mount: StageMount;
  children: ComponentChildren;
}

/**
 * One stage's page: opaque over the Instagram page, hidden when another stage
 * shows, scrolled to the top and replaying its arrival each time it opens.
 */
export function StageHost({ mode, active, mount, children }: StageHostProps): JSX.Element {
  const opened = useRef(mount === 'eager');
  if (active) opened.current = true;
  const host = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!active || el === null) return;
    el.scrollTop = 0;
    staggerCards(el);
  }, [active]);

  return (
    <section
      class={active ? 'stage-view active' : 'stage-view'}
      data-stage={mode}
      data-mount={mount}
      hidden={!active}
      ref={host}
    >
      {opened.current ? children : null}
    </section>
  );
}
