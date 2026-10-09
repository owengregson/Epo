import { type JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { ViewController, ViewKey } from '@/renderer/hooks/useView';
import { staggerCards } from '@/renderer/lib/stagger';

const ORDER: readonly ViewKey[] = ['overview', 'chain', 'queues', 'settings'];

export interface ViewStageProps {
  controller: ViewController;
  /** The rendered content for each view (kept mounted; visibility is class-driven). */
  views: Record<ViewKey, JSX.Element>;
}

/**
 * The view stage. Every view stays mounted inside its own `.view` section so
 * its transient state and one-shot animations survive tab switches; scroll is
 * NOT preserved — App's useScrollReset opens every view at the top. The
 * controller decides which section carries `active`/`entering`/`exiting`, and
 * the newly active section replays its card-entrance cascade.
 */
export function ViewStage({ controller, views }: ViewStageProps): JSX.Element {
  const sections = useRef(new Map<ViewKey, HTMLElement>());
  const current = controller.current;

  useEffect(() => {
    staggerCards(sections.current.get(current) ?? null);
  }, [current]);

  return (
    <div class="stage">
      {ORDER.map((key) => (
        <section
          key={key}
          id={`view-${key}`}
          class={controller.classFor(key)}
          ref={(el) => {
            if (el) sections.current.set(key, el as HTMLElement);
            else sections.current.delete(key);
          }}
        >
          {views[key]}
        </section>
      ))}
    </div>
  );
}
