/**
 * The list walker on the Instagram activity clock (spec §5.16): each walk is one Instagram
 * operation, entering a drawn `dwell.visit` after the previous operation ended and noting its own
 * end. Inside a walk the pages keep their own `walk.page` and `walk.rest` waits.
 */

import { type IgActivityClock, underClock } from '@/rim/ig-activity-clock';
import { ListPageWalker, type ListPageWalkerDeps, type WalkArgs, type WalkResult } from '@/rim/list-page-walker';

export class SpacedListPageWalker extends ListPageWalker {
  private readonly activity: IgActivityClock;
  private readonly entry: Pick<ListPageWalkerDeps, 'clock' | 'abortSignal'>;

  constructor(activity: IgActivityClock, deps: ListPageWalkerDeps) {
    super(deps);
    this.activity = activity;
    this.entry = deps;
  }

  override walkAll(args: WalkArgs): Promise<WalkResult> {
    const now = (): number => this.entry.clock?.now() ?? Date.now();
    return underClock(this.activity, now, this.entry.abortSignal?.(), () => super.walkAll(args));
  }
}
