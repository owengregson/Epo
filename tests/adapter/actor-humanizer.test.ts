/**
 * Actor × Humanizer integration: with a humanizer wired, element LOCATING
 * stays in-page (the surface's locate scripts, matched here by their
 * `actor:locate-*` markers) but every click/scroll goes through the humanizer;
 * without one, the unchanged in-page JS click scripts run.
 */
import { Actor, type ActorHumanizer } from '@/adapter/actor';
import type {
  LocateActionResult,
  LocateRectResult,
  LocateScrollResult,
  LocatedRect,
} from '@/adapter/ig-surface';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const RECT: LocatedRect = { x: 300, y: 200, width: 120, height: 40 };

/** A recording fake humanizer (satisfies ActorHumanizer structurally). */
class FakeHumanizer implements ActorHumanizer {
  clicks: LocatedRect[] = [];
  scrolls: { container: LocatedRect; deltaPx: number }[] = [];
  async click(target: LocatedRect): Promise<void> {
    this.clicks.push(target);
  }
  async scroll(container: LocatedRect, deltaPx: number): Promise<void> {
    this.scrolls.push({ container, deltaPx });
  }
}

/**
 * A fake AdapterTab that dispatches on the script's marker comment. Scripted
 * results are keyed by marker; anything unscripted throws so an unexpected
 * script path fails loudly. Non-locate scripts (the JS click scripts, probes)
 * are matched on stable fragments of their source.
 */
class ScriptedTab {
  url = '';
  evaluated: string[] = [];
  handlers: Array<{ match: (s: string) => boolean; result: () => unknown }> = [];

  on(match: (s: string) => boolean, result: () => unknown): void {
    this.handlers.push({ match, result });
  }
  async goto(u: string): Promise<void> {
    this.url = u;
  }
  currentUrl(): string {
    return this.url;
  }
  async evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T> {
    const script = String(fnOrString);
    this.evaluated.push(script);
    for (const h of this.handlers) {
      if (h.match(script)) return h.result() as T;
    }
    throw new Error(`unscripted evaluate: ${script.slice(0, 80)}`);
  }
}

const marker =
  (m: string) =>
  (s: string): boolean =>
    s.includes(m);

const buildActor = (
  tab: ScriptedTab,
  humanizer?: ActorHumanizer,
): Actor => new Actor(tab, { pollIntervalMs: 1, pollTimeoutMs: 5, humanizer });

describe('follow/unfollow with a humanizer', () => {
  test('follow: locate script finds the button, the HUMANIZER clicks its rect, state verified', async () => {
    const tab = new ScriptedTab();
    const h = new FakeHumanizer();
    // Locate: a Follow button that would be clicked.
    tab.on(marker('actor:locate-action'), (): LocateActionResult => ({
      found: true,
      state: 'follow',
      wouldClick: true,
      needsConfirm: false,
      rect: RECT,
    }));
    // Post-click verification reads Following.
    tab.on(marker('actor:probe-state'), () => ({ found: true, state: 'following' }));

    const result = await buildActor(tab, h).follow('someone');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(true);
    expect(h.clicks).toEqual([RECT]); // the humanizer performed the click
    // The in-page JS CLICK script never ran (no evaluate without a locate/probe marker).
    for (const s of tab.evaluated) {
      expect(s.includes('actor:locate-action') || s.includes('actor:probe-state')).toBe(true);
    }
  });

  test('follow: an already-Following button is a no-click idempotent ok', async () => {
    const tab = new ScriptedTab();
    const h = new FakeHumanizer();
    tab.on(marker('actor:locate-action'), (): LocateActionResult => ({
      found: true,
      state: 'following',
      wouldClick: false,
      needsConfirm: false,
      rect: RECT,
    }));

    const result = await buildActor(tab, h).follow('someone');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(false);
    expect(h.clicks).toEqual([]); // nothing pressed
  });

  test('unfollow: humanizer clicks the button AND the confirm control', async () => {
    const tab = new ScriptedTab();
    const h = new FakeHumanizer();
    const confirmRect: LocatedRect = { x: 400, y: 500, width: 200, height: 44 };
    tab.on(marker('actor:locate-action'), (): LocateActionResult => ({
      found: true,
      state: 'following',
      wouldClick: true,
      needsConfirm: true,
      rect: RECT,
    }));
    tab.on(
      marker('actor:locate-confirm'),
      (): LocateRectResult => ({ found: true, rect: confirmRect }),
    );
    tab.on(marker('actor:probe-state'), () => ({ found: true, state: 'follow' }));

    const result = await buildActor(tab, h).unfollow('someone');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clicked).toBe(true);
    expect(h.clicks).toEqual([RECT, confirmRect]); // button, then confirm
  });
});

describe('dialogs and scrolling with a humanizer', () => {
  test('openFollowersDialog: the stat rect is humanizer-clicked, then the dialog awaited', async () => {
    const tab = new ScriptedTab();
    const h = new FakeHumanizer();
    tab.on(
      marker('actor:locate-stat-followers'),
      (): LocateRectResult => ({ found: true, rect: RECT }),
    );
    // The dialog-present script has no custom marker; match its source shape.
    tab.on((s) => s.includes('present:'), () => ({ present: true }));

    await buildActor(tab, h).openFollowersDialog('target');

    expect(h.clicks).toEqual([RECT]);
  });

  test('scrollFollowers: remaining distance is humanizer-scrolled, capped at 3 viewports', async () => {
    const tab = new ScriptedTab();
    const h = new FakeHumanizer();
    tab.on(marker('actor:locate-scroll'), (): LocateScrollResult => ({
      found: true,
      rect: { x: 100, y: 100, width: 400, height: 600 },
      scrollTop: 0,
      scrollHeight: 5000,
      clientHeight: 600,
    }));

    const scrolled = await buildActor(tab, h).scrollFollowers();

    expect(scrolled).toBe(true);
    expect(h.scrolls).toHaveLength(1);
    expect(h.scrolls[0].deltaPx).toBe(1800); // min(4400 remaining, 3 × 600 viewport)
  });

  test('scrollFollowers: an already-bottomed container reports false, no scroll', async () => {
    const tab = new ScriptedTab();
    const h = new FakeHumanizer();
    tab.on(marker('actor:locate-scroll'), (): LocateScrollResult => ({
      found: true,
      rect: { x: 100, y: 100, width: 400, height: 600 },
      scrollTop: 4400,
      scrollHeight: 5000,
      clientHeight: 600,
    }));

    expect(await buildActor(tab, h).scrollFollowers()).toBe(false);
    expect(h.scrolls).toEqual([]);
  });

  test('scrollFollowers: a missing container reports false (list fits — nothing to scroll)', async () => {
    const tab = new ScriptedTab();
    const h = new FakeHumanizer();
    tab.on(marker('actor:locate-scroll'), (): LocateScrollResult => ({ found: false }));

    expect(await buildActor(tab, h).scrollFollowers()).toBe(false);
    expect(h.scrolls).toEqual([]);
  });
});

describe('fallback without a humanizer (behavior unchanged)', () => {
  test('follow runs the in-page JS click script, never a locate script', async () => {
    const tab = new ScriptedTab();
    // The JS findAndAct script embeds the op constant; the locate scripts carry
    // markers. Script the CLICK path only — a locate evaluation would throw.
    tab.on(
      (s) => s.includes('const OP =') && !s.includes('actor:locate-action'),
      () => ({ found: true, state: 'follow', clicked: true, needsConfirm: false }),
    );
    tab.on(marker('actor:probe-state'), () => ({ found: true, state: 'following' }));

    const result = await buildActor(tab, undefined).follow('someone');

    expect(result.ok).toBe(true);
    expect(tab.evaluated.some((s) => s.includes('actor:locate-action'))).toBe(false);
  });

  test('scrollFollowers runs the in-page jump script, never the locate script', async () => {
    const tab = new ScriptedTab();
    tab.on(
      (s) => s.includes('best.scrollTop = best.scrollHeight'),
      () => ({ found: true, scrollHeight: 5000, scrollTop: 5000 }),
    );

    expect(await buildActor(tab, undefined).scrollFollowers()).toBe(true);
    expect(tab.evaluated.some((s) => s.includes('actor:locate-scroll'))).toBe(false);
  });
});
