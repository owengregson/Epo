/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The direction boards (workplan TK step 0) are what the refresh is signed off
 * against, so they must render, fit, and say only what the product may say:
 * every board at 1024/1440/1920 with no overlapping frames, every sidebar
 * posture's zones adding up at 640/800/920, the stage tabs in the owner's
 * words, the proposed tokens obeying their own rules, and every board one
 * chip away in the `?gallery=1` rail.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { act, cleanup, fireEvent, render, within } from '@testing-library/preact';
import { h } from 'preact';
import { BoardPage } from '@/renderer/gallery/direction/Board';
import {
  FEED_ATTENTION,
  FEED_BOOST,
  FEED_CATCHING_UP,
  FEED_WORKING,
  type FeedEntry,
  FUNNEL,
  LIMITS,
} from '@/renderer/gallery/direction/fixtures';
import {
  BOARD_WIDTHS,
  overlaps,
  PLAN_TABLE_MIN_W,
  type Rect,
  SIDEBAR_HEIGHTS,
  settingsContentWidth,
  sidebarGeometry,
  TODAY_TITLE_H,
} from '@/renderer/gallery/direction/layout';
import { funnelShare } from '@/renderer/gallery/direction/people-page';
import { POPOVER_FRAMES, POSTURES } from '@/renderer/gallery/direction/postures';
import { contrast, PALETTE, SURFACES, TEXT_TOKENS, TYPE_SPECIMEN, tokenStyle } from '@/renderer/gallery/direction/proposed-tokens';
import { BOARDS } from '@/renderer/gallery/direction/registry';
import { DIRECTION_SCENARIOS } from '@/renderer/gallery/direction/scenarios';
import { Gallery, primeGallery } from '@/renderer/gallery/Gallery';

afterEach(cleanup);

function renderBoard(id: string, width: number): HTMLElement {
  return render(h(BoardPage, { id, width })).container as HTMLElement;
}

function px(value: string): number {
  return Number.parseFloat(value || '0');
}

function frameRects(root: HTMLElement): Rect[] {
  return [...root.querySelectorAll<HTMLElement>('.db-frame')].map((f) => ({
    key: f.dataset.frame ?? '',
    x: px(f.style.left),
    y: px(f.style.top),
    w: px(f.style.width),
    h: px(f.style.height),
  }));
}

/** Text a user would read in the product frames (board captions excluded). */
function productText(root: HTMLElement): string {
  return [...root.querySelectorAll('.db-frame__body')].map((b) => b.textContent ?? '').join('\n');
}

describe('every board at every judged width', () => {
  for (const board of BOARDS) {
    for (const width of BOARD_WIDTHS) {
      it(`${board.id} at ${width}: frames inside the canvas, none overlapping`, () => {
        const root = renderBoard(board.id, width);
        const rects = frameRects(root);
        expect(rects.length).toBeGreaterThan(0);
        for (const r of rects) {
          expect({ key: r.key, inside: r.x >= 0 && r.x + r.w <= width && r.w > 0 && r.h > 0 }).toEqual({ key: r.key, inside: true });
        }
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const [a, b] = [rects[i] as Rect, rects[j] as Rect];
            expect({ pair: `${a.key}/${b.key}`, overlap: overlaps(a, b) }).toEqual({ pair: `${a.key}/${b.key}`, overlap: false });
          }
        }
      });
    }
  }
});

describe('the live column', () => {
  for (const height of SIDEBAR_HEIGHTS) {
    it(`at ${height} px every posture's zones add up exactly, in the right mode`, () => {
      const root = renderBoard(`sidebar-${height}`, 1440);
      const cols = [...root.querySelectorAll<HTMLElement>('.dx-col')];
      expect(cols).toHaveLength(POSTURES.length + POPOVER_FRAMES.length);
      const g = sidebarGeometry(height);
      for (const col of cols) {
        expect(px(col.style.height)).toBe(height);
        expect(col.dataset.mode).toBe(g.mode);
        const zones = [...col.children].filter((z) => (z as HTMLElement).dataset.zone !== undefined);
        const parts = zones.map((z) => px((z as HTMLElement).style.height));
        expect(parts.every((p) => p > 0)).toBe(true);
        expect(parts.reduce((s, p) => s + p, 0)).toBe(height);
      }
    });
  }

  it('keeps room for the feed: two rows as drawn, the whole middle when it scrolls', () => {
    expect(sidebarGeometry(800).rest).toBeGreaterThanOrEqual(32 + 2 * 48);
    expect(sidebarGeometry(680).mode).toBe('scroll');
    expect(sidebarGeometry(640)).toMatchObject({ mode: 'compact', now: 176 });
    expect(sidebarGeometry(640).rest).toBeGreaterThanOrEqual(sidebarGeometry(640).today + 2 * 48);
  });

  it('shows the seven postures the step names, Boost on and paused included', () => {
    expect(POSTURES.map((p) => p.id)).toEqual([
      'working',
      'resting',
      'catching-up',
      'needs-attention',
      'boost-on',
      'boost-paused',
      'get-started',
    ]);
  });
});

describe('the stage pages follow the stage width', () => {
  const stage = { 1024: 'narrow', 1440: 'medium', 1920: 'wide' } as const;
  for (const width of BOARD_WIDTHS) {
    it(`at ${width}: Settings is ${stage[width]}, People has ${width >= 1920 ? 'two columns' : 'one column'}`, () => {
      const settings = renderBoard('settings-easy', width);
      expect(settings.querySelector('.dx-set')?.getAttribute('data-layout')).toBe(stage[width]);
      expect(settings.querySelector('.dx-expect') !== null).toBe(width >= 1920);
      expect(settings.querySelector('.dx-rail') !== null).toBe(width >= 1440);
      const people = renderBoard('people', width);
      expect(people.querySelector('.dx-ppl')?.getAttribute('data-cols')).toBe(width >= 1920 ? '2' : '1');
    });
  }

  it('Advanced adds a Fine-tune block and today’s plan in detail; Easy shows no timings', () => {
    const advanced = renderBoard('settings-advanced', 1440);
    expect(advanced.querySelector('.dx-fine')).not.toBeNull();
    expect(advanced.textContent).toContain('Today’s plan in detail');
    const easy = productText(renderBoard('settings-easy', 1440));
    expect(easy).not.toMatch(/an hour|\/h\b|pause between|seconds|\d+ m \d+ s/);
  });
});

describe('the words', () => {
  it('every window reads Live · People · Graph · Prune · Settings', () => {
    for (const id of ['settings-easy', 'settings-advanced', 'people', 'intro']) {
      const root = renderBoard(id, 1440);
      const bars = [...root.querySelectorAll('.dx-tabs')];
      expect(bars.length).toBeGreaterThan(0);
      for (const bar of bars) {
        expect([...bar.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
          'Live',
          'People',
          'Graph',
          'Prune',
          'Settings',
        ]);
      }
    }
  });

  it('product copy stays neutral, says Prune, and keeps capitals for short badges', () => {
    const text = BOARDS.map((b) => productText(renderBoard(b.id, 1440))).join('\n');
    expect(text).not.toMatch(
      /\b(bots?|human\w*|emulat\w*|stealth|mimic\w*|spoof\w*|detect\w*|natural\w*|automation|aggressive|jitter|churn|ceiling|velocity|flagged|whitelist|block(ed|s)?|ban(ned)?)\b/i,
    );
    expect(text).not.toMatch(/\bclean[- ]?up\b|\bcleaning up\b/i);
    expect(text).not.toMatch(/\b[A-Z]{4,}\b/);
  });
});

describe('the boards read the app’s own tokens', () => {
  it('the type specimen prints the generated ladder, 15 px body included', () => {
    expect(TYPE_SPECIMEN.map((t) => t.px)).toEqual([11, 12, 13, 14, 15, 17, 20, 26, 32, 48]);
    expect(TYPE_SPECIMEN.every((t) => t.sample !== '' && t.use !== '')).toBe(true);
  });

  it('every text token the colour specimen shows reaches 4.5:1 on every surface', () => {
    for (const t of TEXT_TOKENS) {
      for (const s of SURFACES) {
        expect({ pair: `${t}/${s}`, ok: contrast(PALETTE[t], PALETTE[s]) >= 4.5 }).toEqual({ pair: `${t}/${s}`, ok: true });
      }
    }
  });

  it('the board root carries nothing inline but its face (until the app declares Inter)', () => {
    const root = renderBoard('tokens', 1024).querySelector<HTMLElement>('.db') as HTMLElement;
    expect(root.style.length).toBe(1);
    expect(root.style.getPropertyValue('--font').trim()).toBe(tokenStyle().slice('--font:'.length));
  });
});

describe('the ?gallery=1 rail', () => {
  it('lists one chip per board', () => {
    expect(DIRECTION_SCENARIOS.map((s) => s.label)).toEqual(BOARDS.map((b) => `Board · ${b.chip}`));
  });

  it('a board chip opens its board, "Back to the gallery" closes it, and the chip opens it again', async () => {
    primeGallery();
    render(h(Gallery, {}));
    await act(async () => {});
    const rail = within(document.querySelector('.gallery-rail') as HTMLElement);
    await act(async () => {
      fireEvent.click(rail.getByText('Board · People'));
    });
    expect(document.querySelector('.db[data-board="people"]')).not.toBeNull();
    expect(document.documentElement.classList.contains('db-open')).toBe(true);
    await act(async () => {
      fireEvent.click(within(document.querySelector('.db-bar') as HTMLElement).getByText('Back to the gallery'));
    });
    expect(document.querySelector('.db')).toBeNull();
    expect(document.documentElement.classList.contains('db-open')).toBe(false);
    await act(async () => {
      fireEvent.click(rail.getByText('Board · People'));
    });
    expect(document.querySelector('.db[data-board="people"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(document.querySelector('.db-bar') as HTMLElement).getByText('Back to the gallery'));
    });
  });
});

/** A board stylesheet's text, for the rules a layout-free DOM cannot measure. */
function sheet(name: string): string {
  return readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'gallery', 'direction', name), 'utf8');
}

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
}

describe('the design review, folded in', () => {
  it('the ring glyph stays in flow: only the ring’s own drawing is placed absolutely', () => {
    const css = sheet('sidebar.css');
    expect(rule(css, '.dx-ring > svg')).toContain('position: absolute');
    expect(css).not.toMatch(/\.dx-ring svg\s*\{/);
  });

  it('nothing in the column loops but the two breaths (the mark, the Live dot); the Now ring never spins', () => {
    const loops = ['sidebar.css', 'stage.css'].flatMap((f) => sheet(f).match(/animation:[^;]*infinite/g) ?? []);
    expect(loops).toHaveLength(2);
    expect(loops.every((l) => l.includes('dx-breathe'))).toBe(true);
    expect(POSTURES.every((p) => p.ring.mode !== 'deplete' || p.next !== null)).toBe(true);
  });

  it('every feed sentence fits its row; a reason or a list goes to the detail line, never cut', () => {
    const feeds: FeedEntry[] = [...FEED_WORKING, ...FEED_CATCHING_UP, ...FEED_BOOST, ...FEED_ATTENTION];
    for (const e of feeds) {
      if (!('id' in e)) continue;
      const line = e.parts.join('');
      expect({ line, fits: line.length <= 34 && !line.includes(' — ') }).toEqual({ line, fits: true });
    }
  });

  it('the divider is a strict time boundary: “While you were away” sits above it', () => {
    for (const feed of [FEED_WORKING, FEED_BOOST]) {
      const away = feed.findIndex((e) => 'id' in e && e.parts[0] === 'While you were away');
      expect(away).toBeLessThan(feed.findIndex((e) => 'divider' in e));
    }
  });

  it('posture headlines keep to 15 characters (spec §12.2)', () => {
    for (const p of POSTURES) expect({ h: p.headline, ok: p.headline.length <= 15 }).toEqual({ h: p.headline, ok: true });
  });

  it('the Today title row and the Boost band are one fixed height, so Boost moves nothing', () => {
    const root = renderBoard('sidebar-800', 1440);
    const firstRows = [...root.querySelectorAll<HTMLElement>('.dx-today')].map((t) => t.firstElementChild as HTMLElement);
    expect(firstRows.some((r) => r.classList.contains('dx-band'))).toBe(true);
    for (const r of firstRows) expect(px(r.style.height)).toBe(TODAY_TITLE_H);
  });

  it('Settings at 1024 keeps every section in view as wrapping chips', () => {
    const root = renderBoard('settings-advanced', 1024);
    const chips = root.querySelector('[data-frame="settings-advanced-timing"] .dx-set__chips') as HTMLElement;
    expect(chips.querySelectorAll('button')).toHaveLength(12);
    expect(chips.querySelector('[aria-current="true"]')?.textContent).toBe('Timing');
    const css = rule(sheet('stage.css'), '.dx-set__chips');
    expect(css).toContain('flex-wrap: wrap');
    expect(css).not.toContain('overflow');
  });

  it('today’s plan in detail is a table only where it fits, otherwise one sentence per session', () => {
    for (const width of BOARD_WIDTHS) {
      const root = renderBoard('settings-advanced', width);
      const table = settingsContentWidth(width - 460, 'advanced') >= PLAN_TABLE_MIN_W;
      expect({ width, table: root.querySelector('.dx-plan__table') !== null }).toEqual({ width, table });
      if (!table) {
        const items = [...root.querySelectorAll('.dx-plan__sessions li')];
        expect(items).toHaveLength(5);
        for (const li of items) {
          expect(li.querySelector('.dx-plan__when')?.textContent).toMatch(/^ Session \d · \d/);
          expect(li.querySelector('.dx-plan__what')?.textContent).toMatch(
            /^\d+ follows? · \d+ unfollows? · \d+ approvals? · \w+ pace · average pause \d.* · shortest \d.*$/,
          );
        }
      }
    }
  });

  it('Easy’s “When Epo works” offers the three session styles, the middle one recommended', () => {
    const text = productText(renderBoard('settings-easy', 1024));
    for (const t of ['Many short visits', 'A few regular sessions', 'A couple of longer sessions']) expect(text).toContain(t);
    const group = renderBoard('settings-easy', 1440).querySelector('[aria-label="Session style"]') as HTMLElement;
    const cards = group.querySelectorAll('.dx-card');
    expect([...cards].map((c) => c.querySelector('.dx-tag') !== null)).toEqual([false, true, false]);
  });

  it('Advanced prints one value per limit wherever it appears', () => {
    const text = productText(renderBoard('settings-advanced', 1920));
    expect(text).toContain(`At most an hour${LIMITS.hourly} (`);
    expect(text).toContain(`Hard stop${LIMITS.hardStop} actions`);
    expect(text).toContain(`At most ${LIMITS.hourly} an hour · hard stop ${LIMITS.hardStop} a day`);
    expect(text).not.toMatch(/At most an hour(?!22)\d+/);
  });

  it('funnel bars are the true linear share of the first stage', () => {
    const shares = FUNNEL.map((f) => funnelShare(f.value));
    expect(shares[0]).toBe(100);
    for (const [i, f] of FUNNEL.entries()) expect(shares[i]).toBeCloseTo((Number(f.value.replace(/,/g, '')) / 8150) * 100, 6);
  });

  it('under reduced motion the splash shows a still, even hairline, not a stuck highlight', () => {
    const css = sheet('launch.css');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rule(reduced, '  .dx-splash__shimmer::after')).toContain('display: none');
  });
});
