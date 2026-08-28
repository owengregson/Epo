/** @jsx h */
import { h } from 'preact';
import type { ViewController, ViewKey } from '../hooks/useView';

const ORDER: readonly ViewKey[] = ['overview', 'chain', 'queues', 'settings'];

export interface ViewStageProps {
  controller: ViewController;
  /** The rendered content for each view (kept mounted; visibility is class-driven). */
  views: Record<ViewKey, h.JSX.Element>;
}

/**
 * The view stage. Every view stays mounted inside its own `.view` section so
 * its transient state and one-shot animations survive tab switches; scroll is
 * NOT preserved — App's useScrollReset opens every view at the top. The
 * controller decides which section carries `active`/`entering`/`exiting`.
 */
export function ViewStage({ controller, views }: ViewStageProps): h.JSX.Element {
  return (
    <div class="stage">
      {ORDER.map((key) => (
        <section key={key} id={`view-${key}`} class={controller.classFor(key)}>
          {views[key]}
        </section>
      ))}
    </div>
  );
}
