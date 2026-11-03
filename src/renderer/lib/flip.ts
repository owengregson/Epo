import { play } from '@/renderer/lib/play';

/** How long the moves take, from the caller's motion tokens. */
export interface FlipTiming {
  readonly duration: number;
  readonly easing: string;
}

/**
 * The "arrive" and "file-into" gestures (spec §12.7) for a list that grows: the
 * rows already there glide from where they were to where they land after
 * `mutate()`, and each new row rises 8 px into place — or, given `from`, travels
 * from that rect (the line that just finished) into its row. Only transform and
 * opacity move; under reduced motion everything simply appears (`play`).
 */
export function flipInsert(
  container: HTMLElement,
  mutate: () => void,
  timing: FlipTiming,
  opts: { from?: DOMRect } = {},
): void {
  const before = new Map<Element, DOMRect>();
  for (const child of Array.from(container.children)) before.set(child, child.getBoundingClientRect());
  mutate();
  for (const child of Array.from(container.children)) {
    const first = before.get(child);
    const last = child.getBoundingClientRect();
    if (first !== undefined) {
      const dy = first.top - last.top;
      if (dy !== 0) void play(child, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], timing);
      continue;
    }
    const from = opts.from;
    const frames: Keyframe[] =
      from === undefined
        ? [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }]
        : [{ transform: `translate(${from.left - last.left}px, ${from.top - last.top}px)` }, { transform: 'none' }];
    void play(child, frames, timing);
  }
}
