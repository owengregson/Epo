/**
 * The unfollow confirm flow (ADR 0308, spec §11.2): one admission per action, then each confirm
 * layer located, paused on and pressed until Instagram answers. The page is a small model of what
 * Instagram renders after each press, served to the Actor through a scripted network tab.
 */
import { Actor } from '@/adapter/actor';
import { ActionDeferredError } from '@/adapter/errors';
import type { LocatedRect } from '@/adapter/ig-surface';
import { SURFACE } from '@/adapter/ig-surface';
import { lookBeforeActing } from '@/adapter/instagram-adapter';
import { FakeInteractor, marker, NetworkTab, pageCall } from '../kit/tabs';
import { recordingTempo } from '../kit/tempo';

const HEADER: LocatedRect = { x: 360, y: 212, width: 324, height: 44 };
const MENU_ROW: LocatedRect = { x: 420, y: 501, width: 560, height: 54 };
const DIALOG_BUTTON: LocatedRect = { x: 520, y: 480, width: 400, height: 48 };
const CANCEL: LocatedRect = { x: 520, y: 530, width: 400, height: 48 };
const CLOSE: LocatedRect = { x: 900, y: 300, width: 18, height: 18 };
const UNFOLLOW_URL = 'https://www.instagram.com/api/v1/web/friendships/123/unfollow/';

type State = 'follow' | 'following' | 'requested';

/** One confirm layer as the page reports it. */
interface Layer {
  sig: string;
  kind: 'menu' | 'dialog';
  /** The confirm control; `null` when the text pass misses (an unexpected layer). */
  confirm: LocatedRect | null;
  cancel: LocatedRect | null;
  close: LocatedRect | null;
  controls: number;
  structural: string | null;
}

const menu = (): Layer =>
  ({ sig: '0:6:menu', kind: 'menu', confirm: MENU_ROW, cancel: null, close: CLOSE, controls: 6, structural: null });
const dialog = (): Layer =>
  ({ sig: '0:2:dialog', kind: 'dialog', confirm: DIALOG_BUTTON, cancel: CANCEL, close: null, controls: 2, structural: 'Unfollow' });

/** What a press of the header, a confirm control, Cancel or the Close X does on this page. */
interface Script {
  header?: () => void;
  confirm?: (layer: Layer) => void;
}

/** A profile page that renders confirm layers and fires the mutation when the script says so. */
class ConfirmPage {
  readonly tab = new NetworkTab();
  readonly h = new FakeInteractor();
  readonly layers: Layer[] = [];
  readonly events: string[] = [];
  state: State;

  constructor(state: State, script: Script) {
    this.state = state;
    this.tab.on(pageCall('locateActionButton'), () => {
      const unfollow = this.tab.evaluated[this.tab.evaluated.length - 1].includes('"op":"unfollow"');
      const wouldClick = unfollow === (this.state !== 'follow');
      return { found: true, state: this.state, rect: HEADER, wouldClick, needsConfirm: unfollow && wouldClick };
    });
    this.tab.on(pageCall('probeActionButton'), () => ({ found: true, state: this.state }));
    this.tab.on(pageCall('locateConfirm'), () => {
      const top = this.top();
      return top?.confirm ? { found: true, rect: top.confirm, layer: top.kind, sig: top.sig } : { found: false };
    });
    this.tab.on(pageCall('confirmLayer'), () => {
      const top = this.top();
      return top === null ? { present: false } : { present: true, sig: top.sig, layer: top.kind, controls: top.controls,
        matches: top.confirm !== null, structural: top.structural, markup: `<div role="dialog">${top.sig}</div>` };
    });
    this.tab.on(marker('"control":"unfollow-dialog-cancel"'), () =>
      this.top()?.cancel ? { found: true, rect: this.top()?.cancel } : { found: false });
    this.tab.on(marker('"control":"drawer-close"'), () =>
      this.top()?.close ? { found: true, rect: this.top()?.close } : { found: false });
    this.tab.on(pageCall('blockText'), () => '');
    this.h.onClick = () => {
      const rect = this.h.clicks[this.h.clicks.length - 1];
      this.events.push(`press:${this.name(rect)}`);
      const top = this.top();
      if (rect === HEADER) script.header?.();
      else if (top !== null && rect === top.confirm) script.confirm?.(top);
      else if (top !== null && (rect === top.cancel || rect === top.close)) this.layers.pop();
    };
  }

  top(): Layer | null {
    return this.layers[this.layers.length - 1] ?? null;
  }

  /** Instagram accepts the unfollow: the response arrives and the header flips. */
  land(): void {
    this.layers.length = 0;
    this.state = 'follow';
    this.tab.emit({ url: UNFOLLOW_URL, status: 200, body: { status: 'ok' } });
  }

  private name(rect: LocatedRect): string {
    const names: Array<[LocatedRect, string]> = [[HEADER, 'header'], [MENU_ROW, 'menu-row'], [DIALOG_BUTTON, 'dialog'],
      [CANCEL, 'cancel'], [CLOSE, 'close']];
    return names.find(([r]) => r === rect)?.[1] ?? 'unknown';
  }
}

/** A dwell-free Actor over the page; `admit` is the cadence's `beforeMutation`. */
function actorOn(page: ConfirmPage, admit: () => Promise<void> = async () => {}): Actor {
  return new Actor(page.tab, {
    pollIntervalMs: 1, pollTimeoutMs: 30, mutationTimeoutMs: 30, interactor: page.h, beforeMutation: admit,
    prepareProfile: async (username) => { await page.tab.goto(SURFACE.profileUrl(username)); },
  });
}

/** A `beforeMutation` that admits once and refuses after: the real cadence's re-check contract. */
const admitsOnce = () => jest.fn()
  .mockResolvedValueOnce(undefined)
  .mockRejectedValue(new ActionDeferredError('relationship reconciliation required'));

describe('F1: one admission per action', () => {
  test('Variant R (Requested → dialog): a second admission would refuse, and none happens', async () => {
    const page = new ConfirmPage('requested', {
      header: () => page.layers.push(dialog()),
      confirm: () => page.land(),
    });
    const admit = admitsOnce();
    const journal = jest.fn();

    const result = await actorOn(page, admit).unfollow('someone', 'pk', journal);

    expect(result.ok).toBe(true);
    expect(page.h.clicks).toEqual([HEADER, DIALOG_BUTTON]);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledTimes(1);
  });

  test.each(['follow', 'unfollow'] as const)('a refusing admission presses nothing on a %s', async (op) => {
    const page = new ConfirmPage(op === 'follow' ? 'follow' : 'following', { header: () => page.layers.push(menu()) });
    const refusal = new ActionDeferredError('cadence: the deadline has not passed');
    const journal = jest.fn();
    const actor = actorOn(page, async () => { throw refusal; });

    await expect(op === 'follow' ? actor.follow('someone', 'pk', journal) : actor.unfollow('someone', 'pk', journal))
      .rejects.toBe(refusal);
    expect(page.h.clicks).toEqual([]);
    expect(page.h.hovers).toEqual([]);
    expect(journal).not.toHaveBeenCalled();
  });

  test('the look-before-act dwell precedes the admission, which precedes the header press', async () => {
    const page = new ConfirmPage('following', { header: () => page.layers.push(menu()), confirm: () => page.land() });
    const order: string[] = [];
    const visit = async (username: string): Promise<void> => {
      order.push('visit');
      await page.tab.goto(SURFACE.profileUrl(username));
    };
    const dwell = async (): Promise<void> => { order.push('dwell'); };
    page.h.onClick = ((react) => () => { order.push('press'); react?.(); })(page.h.onClick);
    const actor = new Actor(page.tab, {
      pollIntervalMs: 1, pollTimeoutMs: 30, mutationTimeoutMs: 30, interactor: page.h,
      prepareProfile: lookBeforeActing(visit, recordingTempo(), undefined, dwell),
      beforeMutation: async () => { order.push('admit'); },
    });

    await actor.unfollow('someone', 'pk', () => order.push('journal'));

    expect(order.slice(0, 5)).toEqual(['visit', 'dwell', 'admit', 'journal', 'press']);
  });
});
