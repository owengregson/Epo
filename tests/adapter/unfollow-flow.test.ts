/**
 * The unfollow confirm flow (ADR 0308, spec §11.2): one admission per action, then each confirm
 * layer located, paused on and pressed until Instagram answers. The page is a small model of what
 * Instagram renders after each press, served to the Actor through a scripted network tab.
 */
import { Actor } from '@/adapter/actor';
import type { ConfirmCapture, ConfirmCaptureRecord } from '@/adapter/confirm-capture';
import { ActionDeferredError } from '@/adapter/errors';
import type { LocatedRect } from '@/adapter/ig-surface';
import { SURFACE } from '@/adapter/ig-surface';
import { lookBeforeActing } from '@/adapter/instagram-adapter';
import { MUTATION_BLINDNESS } from '@/adapter/mutation-watch';
import type { TempoSource } from '@/kernel/tempo';
import { MemorySink, type SurfaceSink } from '@/surface/sink';
import { setLevel, setSink } from '@/utils/logger';
import { FakeInteractor, marker, NetworkTab, pageCall } from '../kit/tabs';
import { fixedTempo, recordingTempo } from '../kit/tempo';

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

/** A layer's markup as the page would hand it over: the account's handle, its link, an image, a long id. */
const markupOf = (layer: Layer): string =>
  `<div role="dialog" data-sig="${layer.sig}"><a href="/someone/">someone</a>`
  + '<span>If you change your mind, you\'ll have to request to follow @someone again.</span>'
  + '<img src="https://scontent.cdninstagram.com/v/t51/123456789012_n.jpg"></div>';

/** A capture that keeps what it is handed, each signature once. */
function recordingCapture(): ConfirmCapture & { records: ConfirmCaptureRecord[] } {
  const kept = new Set<string>();
  const records: ConfirmCaptureRecord[] = [];
  return { records, wants: (sig) => !kept.has(sig), save: (sig, record) => { kept.add(sig); records.push(record); } };
}

/** What a press of the header or a confirm control does on this page (Cancel and the X close the top layer). */
interface Script {
  header?: () => void;
  confirm?: (layer: Layer) => void;
  /** Called on every confirm locate: lets a layer linger, then change. */
  poll?: () => void;
}

/** A profile page that renders confirm layers and fires the mutation when the script says so. */
class ConfirmPage {
  readonly tab = new NetworkTab();
  readonly h = new FakeInteractor();
  readonly layers: Layer[] = [];
  readonly events: string[] = [];
  state: State;

  constructor(state: State, scripted: Script | ((page: ConfirmPage) => Script)) {
    this.state = state;
    const script = typeof scripted === 'function' ? scripted(this) : scripted;
    this.tab.on(pageCall('locateActionButton'), () => {
      const unfollow = this.tab.evaluated[this.tab.evaluated.length - 1].includes('"op":"unfollow"');
      const wouldClick = unfollow === (this.state !== 'follow');
      return { found: true, state: this.state, rect: HEADER, wouldClick, needsConfirm: unfollow && wouldClick };
    });
    this.tab.on(pageCall('probeActionButton'), () => ({ found: true, state: this.state }));
    this.tab.on(pageCall('locateConfirm'), () => {
      script.poll?.();
      const top = this.top();
      return top?.confirm ? { found: true, rect: top.confirm, layer: top.kind, sig: top.sig } : { found: false };
    });
    this.tab.on(pageCall('confirmLayer'), () => {
      const top = this.top();
      const withMarkup = this.tab.evaluated[this.tab.evaluated.length - 1].includes('"withMarkup":true');
      return top === null ? { present: false } : { present: true, sig: top.sig, layer: top.kind, controls: top.controls,
        matches: top.confirm !== null, structural: top.structural, markup: withMarkup ? markupOf(top) : undefined };
    });
    this.tab.on(marker('"control":"unfollow-dialog-cancel"'), () =>
      this.top()?.cancel ? { found: true, rect: this.top()?.cancel } : { found: false });
    this.tab.on(marker('"control":"drawer-close"'), () =>
      this.top()?.close ? { found: true, rect: this.top()?.close } : { found: false });
    this.tab.on(pageCall('blockText'), () => '');
    const hover = this.h.hover.bind(this.h);
    this.h.hover = async (target: LocatedRect) => {
      this.events.push(`hover:${this.name(target)}`);
      await hover(target);
    };
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

interface ActorOpts {
  admit?: () => Promise<void>;
  tempo?: TempoSource;
  sink?: SurfaceSink;
  capture?: ConfirmCapture;
  abort?: AbortController;
}

/** A dwell-free Actor over the page; `admit` is the cadence's `beforeMutation`, every step pause is recorded. */
function actorOn(page: ConfirmPage, opts: ActorOpts = {}): Actor {
  return new Actor(page.tab, {
    pollIntervalMs: 1, pollTimeoutMs: 30, mutationTimeoutMs: 30, interactor: page.h,
    beforeMutation: opts.admit ?? (async () => {}), tempo: opts.tempo, sink: opts.sink, capture: opts.capture,
    abortSignal: opts.abort === undefined ? undefined : () => opts.abort?.signal,
    sleep: async () => { page.events.push('pause'); },
    prepareProfile: async (username) => { await page.tab.goto(SURFACE.profileUrl(username)); },
  });
}

/** Variant P: a private account you follow — the menu sheet, then the dialog, then the answer. */
const variantP = (page: ConfirmPage): Script => ({
  header: () => page.layers.push(menu()),
  confirm: (layer) => {
    if (layer.kind === 'menu') page.layers.splice(0, page.layers.length, dialog());
    else page.land();
  },
});

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

    const result = await actorOn(page, { admit }).unfollow('someone', 'pk', journal);

    expect(result.ok).toBe(true);
    expect(page.h.clicks).toEqual([HEADER, DIALOG_BUTTON]);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledTimes(1);
  });

  test.each(['follow', 'unfollow'] as const)('a refusing admission presses nothing on a %s', async (op) => {
    const page = new ConfirmPage(op === 'follow' ? 'follow' : 'following', { header: () => page.layers.push(menu()) });
    const refusal = new ActionDeferredError('cadence: the deadline has not passed');
    const journal = jest.fn();
    const actor = actorOn(page, { admit: async () => { throw refusal; } });

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

describe('F2: each confirm layer is pressed until Instagram answers', () => {
  test('Variant P (private, Following): the header, the menu row, then the dialog — one admission', async () => {
    const page = new ConfirmPage('following', variantP);
    const admit = admitsOnce();
    const journal = jest.fn();

    const result = await actorOn(page, { admit }).unfollow('someone', 'pk', journal);

    expect(result.ok).toBe(true);
    expect(page.h.clicks).toEqual([HEADER, MENU_ROW, DIALOG_BUTTON]);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledTimes(1);
  });

  test('a menu that lingers after its press is never pressed again; the dialog that replaces it is', async () => {
    let lingering = 0;
    const page = new ConfirmPage('following', (p) => ({
      header: () => p.layers.push(menu()),
      confirm: (layer) => {
        if (layer.kind === 'menu') lingering = 3;
        else p.land();
      },
      poll: () => {
        if (lingering > 0 && --lingering === 0) p.layers.push(dialog());
      },
    }));

    const result = await actorOn(page).unfollow('someone', 'pk');

    expect(result.ok).toBe(true);
    expect(page.h.clicks).toEqual([HEADER, MENU_ROW, DIALOG_BUTTON]);
  });

  test('a public account: the menu press fires the mutation — two presses and at most one more poll', async () => {
    const page = new ConfirmPage('following', (p) => ({ header: () => p.layers.push(menu()), confirm: () => p.land() }));

    const result = await actorOn(page).unfollow('someone', 'pk');

    expect(result.ok).toBe(true);
    expect(page.h.clicks).toEqual([HEADER, MENU_ROW]);
    const laterLocates = page.tab.evaluated.filter((s) => pageCall('locateConfirm', '"dialogsOnly":true')(s));
    expect(laterLocates.length).toBeLessThanOrEqual(1);
  });

  test('a later layer on a page that is no longer the profile is never travelled to, pressed or cancelled', async () => {
    const page = new ConfirmPage('following', (p) => ({
      header: () => p.layers.push(menu()),
      confirm: () => {
        p.layers.splice(0, p.layers.length, dialog());
        void p.tab.goto('https://www.instagram.com/someone_else/');
      },
    }));

    await expect(actorOn(page).unfollow('someone', 'pk')).rejects.toThrow(/profile changed/);
    expect(page.h.clicks).toEqual([HEADER, MENU_ROW]);
    expect(page.h.hovers).toEqual([MENU_ROW]);
  });

  test('Variant R answered inline at the header press: no layer is pressed', async () => {
    const page = new ConfirmPage('requested', (p) => ({ header: () => p.land() }));

    const result = await actorOn(page).unfollow('someone', 'pk');

    expect(result.ok).toBe(true);
    expect(page.h.clicks).toEqual([HEADER]);
  });

  test('a follow expects no layer: an unexpected dialog is never pressed', async () => {
    const page = new ConfirmPage('follow', (p) => ({ header: () => p.layers.push(dialog()) }));

    const result = await actorOn(page).follow('someone', 'pk');

    expect(result.ok).toBe(false);
    expect(page.h.clicks.filter((r) => r === DIALOG_BUTTON)).toEqual([]);
  });
});

describe('F4: a stall on screen is not a blind mutation table', () => {
  beforeEach(() => MUTATION_BLINDNESS.reset());

  test('a dialog whose button never becomes pressable: Cancel, blindness unchanged, an honest error', async () => {
    const stuck: Layer = { ...dialog(), confirm: { x: 0, y: 0, width: 0, height: 0 } };
    const page = new ConfirmPage('requested', (p) => ({ header: () => p.layers.push(stuck) }));
    const sink = new MemorySink();

    const result = await actorOn(page, { sink }).unfollow('someone', 'pk');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/post-click state not confirmed/);
    expect(page.h.clicks).toEqual([HEADER, CANCEL]);
    expect(page.layers).toEqual([]);
    expect(MUTATION_BLINDNESS.streak()).toBe(0);
    // The confirm text was there, just never pressable: a stall, not an unknown layer.
    expect(sink.snapshot().drift).toEqual([]);
  });

  test('with nothing on screen, an unobserved window still counts toward blindness', async () => {
    const page = new ConfirmPage('requested', {});

    await actorOn(page).unfollow('someone', 'pk');

    expect(MUTATION_BLINDNESS.streak()).toBe(1);
  });
});

describe('F5: an exit that did not land leaves the tab clean', () => {
  /** The menu press opened a "Restrict @x?" dialog instead: two buttons, no confirm text (spec §11.2 item 9). */
  const restrict = (): Layer => ({ sig: '0:2:restrict', kind: 'dialog', confirm: null, cancel: CANCEL, close: null,
    controls: 2, structural: 'Restrict' });

  test('an unexpected two-button dialog on a later layer: never pressed, Cancel, a confirm-unrecognized signature', async () => {
    const page = new ConfirmPage('following', (p) => ({
      header: () => p.layers.push(menu()),
      confirm: () => p.layers.splice(0, p.layers.length, restrict()),
    }));
    const sink = new MemorySink();
    const capture = recordingCapture();

    const result = await actorOn(page, { sink, capture }).unfollow('someone', 'pk');

    expect(result.ok).toBe(false);
    expect(page.h.clicks).toEqual([HEADER, MENU_ROW, CANCEL]);
    expect(sink.snapshot().drift.map((d) => [d.signal.endpoint, d.signal.cls, d.signal.detail.op])).toEqual([
      ['mutation', 'confirm-unrecognized', 'actor.unfollow'],
    ]);
    // The capture request: the unknown layer's markup, scrubbed, and the control it offered (never pressed).
    expect(capture.records.map((r) => [r.reason, r.layer, r.structural])).toEqual([['unrecognized', 'dialog', 'Restrict']]);
  });

  test('a menu left on screen has no Cancel: its Close X closes it', async () => {
    const page = new ConfirmPage('following', (p) => ({ header: () => p.layers.push(menu()) }));

    // The menu row is pressed but nothing follows: the same layer stays, then the X closes it.
    const result = await actorOn(page).unfollow('someone', 'pk');

    expect(result.ok).toBe(false);
    expect(page.h.clicks).toEqual([HEADER, MENU_ROW, CLOSE]);
    expect(page.layers).toEqual([]);
  });

  test('a layer nothing can close is a warn, never silent', async () => {
    const stuck: Layer = { ...dialog(), confirm: null, cancel: null, structural: null };
    const page = new ConfirmPage('requested', (p) => ({ header: () => p.layers.push(stuck) }));
    const lines: string[] = [];
    setLevel('warn');
    setSink((level, message) => { if (level === 'warn') lines.push(message); });
    try {
      await actorOn(page).unfollow('someone', 'pk');
    } finally {
      setSink(null);
      setLevel('error');
    }

    expect(page.h.clicks).toEqual([HEADER]);
    expect(lines.some((m) => m.includes('stayed on screen'))).toBe(true);
  });

  test("Instagram's refusal with the dialog still up: Cancel, and no drift (the refusal is evidence)", async () => {
    const page = new ConfirmPage('requested', (p) => ({
      header: () => p.layers.push(dialog()),
      confirm: () => p.tab.emit({ url: UNFOLLOW_URL, status: 400, body: { status: 'fail', message: 'feedback_required', spam: true } }),
    }));
    const sink = new MemorySink();

    await expect(actorOn(page, { sink }).unfollow('someone', 'pk')).rejects.toThrow();
    expect(page.h.clicks).toEqual([HEADER, DIALOG_BUTTON, CANCEL]);
    expect(sink.snapshot().drift).toEqual([]);
  });

  test('a stop mid-flow presses nothing more: no Cancel after a stop', async () => {
    const abort = new AbortController();
    let polls = 0;
    const stuck: Layer = { ...dialog(), confirm: { x: 0, y: 0, width: 0, height: 0 } };
    const page = new ConfirmPage('requested', (p) => ({
      header: () => p.layers.push(stuck),
      poll: () => { if (++polls === 2) abort.abort(); },
    }));

    await expect(actorOn(page, { abort }).unfollow('someone', 'pk')).rejects.toThrow();
    expect(page.h.clicks).toEqual([HEADER]);
  });

  test('a follow that did not land with a dialog on screen: the dialog is never pressed; Cancel closes it', async () => {
    const page = new ConfirmPage('follow', (p) => ({ header: () => p.layers.push(restrict()) }));
    const sink = new MemorySink();

    const result = await actorOn(page, { sink }).follow('someone', 'pk');

    expect(result.ok).toBe(false);
    expect(page.h.clicks).toEqual([HEADER, CANCEL]);
    expect(sink.snapshot().drift.map((d) => d.signal.detail.op)).toEqual(['actor.follow']);
  });
});

describe('in-action pacing (spec §11.2 item 11)', () => {
  test('Variant P with the plan tempo: one step pause per located layer, before its travel', async () => {
    const page = new ConfirmPage('following', variantP);
    const tempo = recordingTempo();

    expect((await actorOn(page, { tempo }).unfollow('someone', 'pk')).ok).toBe(true);

    expect(page.events).toEqual(['press:header', 'pause', 'hover:menu-row', 'press:menu-row', 'pause', 'hover:dialog',
      'press:dialog']);
    expect(tempo.keys.filter((k) => k === 'ui.step-pause')).toHaveLength(2);
  });

  test('Variant R with the plan tempo: one pause before the dialog', async () => {
    const page = new ConfirmPage('requested', (p) => ({ header: () => p.layers.push(dialog()), confirm: () => p.land() }));

    expect((await actorOn(page, { tempo: recordingTempo() }).unfollow('someone', 'pk')).ok).toBe(true);

    expect(page.events).toEqual(['press:header', 'pause', 'hover:dialog', 'press:dialog']);
  });

  test('under the reference tempo the step pause stays off (until the plan swaps its tempo in)', async () => {
    const page = new ConfirmPage('following', variantP);

    expect((await actorOn(page).unfollow('someone', 'pk')).ok).toBe(true);

    expect(page.events).not.toContain('pause');
  });

  test('the Actor hands its tempo to the list scroll: a deeper session scrolls further', async () => {
    const scrolled = async (tempo?: TempoSource): Promise<number> => {
      const page = new ConfirmPage('follow', {});
      page.tab.on(pageCall('locateScrollContainer'), () =>
        ({ found: true, rect: MENU_ROW, scrollTop: 0, scrollHeight: 20_000, clientHeight: 500 }));
      await actorOn(page, { tempo }).scrollFollowers();
      return page.h.scrolls[0].deltaPx;
    };
    expect(await scrolled(fixedTempo(0.5))).toBe(2 * (await scrolled()));
  });
});

describe('the passive capture (spec §11.1, §22 L5)', () => {
  test('a layer met after the first is captured once — not once per account — scrubbed, with the POSTs', async () => {
    const capture = recordingCapture();
    let account = 0;
    const page = new ConfirmPage('following', (p) => ({
      header: () => p.layers.push(menu()),
      // The dialog's text names the account, so each account's dialog signs differently.
      confirm: (layer) => {
        if (layer.kind === 'menu') p.layers.splice(0, p.layers.length, { ...dialog(), sig: `0:2:dialog-${account}` });
        else p.land();
      },
    }));
    const actor = actorOn(page, { capture });

    expect((await actor.unfollow('someone', 'pk')).ok).toBe(true);
    page.state = 'following';
    account += 1;
    expect((await actor.unfollow('someone', 'pk')).ok).toBe(true);

    expect(capture.records).toHaveLength(1);
    const [record] = capture.records;
    expect(record).toMatchObject({ reason: 'later-layer', op: 'actor.unfollow', layer: 'dialog', controls: 2 });
    expect(record.markup).not.toMatch(/someone|cdninstagram|123456789012/);
    expect(record.markup).toContain('request to follow @user_a1 again');
    expect(Array.isArray(record.unmatchedPosts)).toBe(true);
  });

  test('a layer left on screen is captured as such before it is closed', async () => {
    const capture = recordingCapture();
    const stuck: Layer = { ...dialog(), confirm: { x: 0, y: 0, width: 0, height: 0 } };
    const page = new ConfirmPage('requested', (p) => ({ header: () => p.layers.push(stuck) }));

    await actorOn(page, { capture }).unfollow('someone', 'pk');

    expect(capture.records.map((r) => r.reason)).toEqual(['left-visible']);
    expect(page.h.clicks).toEqual([HEADER, CANCEL]);
  });

  test('a public account shows no later layer: nothing is captured', async () => {
    const capture = recordingCapture();
    const page = new ConfirmPage('following', (p) => ({ header: () => p.layers.push(menu()), confirm: () => p.land() }));

    expect((await actorOn(page, { capture }).unfollow('someone', 'pk')).ok).toBe(true);
    expect(capture.records).toEqual([]);
  });
});
