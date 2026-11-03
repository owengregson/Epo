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
import { act, cleanup, fireEvent, render, within } from '@testing-library/preact';
import { h } from 'preact';
import { BoardPage } from '@/renderer/gallery/direction/Board';
import { BOARD_WIDTHS, overlaps, type Rect, SIDEBAR_HEIGHTS, sidebarGeometry } from '@/renderer/gallery/direction/layout';
import { POSTURES } from '@/renderer/gallery/direction/postures';
import {
  contrast,
  DUR_MS,
  PALETTE,
  PERCEPTION_MS,
  SURFACES,
  TEXT_TOKENS,
  TYPE_LADDER,
  tokenStyle,
} from '@/renderer/gallery/direction/proposed-tokens';
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
      expect(cols).toHaveLength(POSTURES.length);
      const g = sidebarGeometry(height);
      for (const col of cols) {
        expect(px(col.style.height)).toBe(height);
        expect(col.dataset.mode).toBe(g.mode);
        const parts = [...col.children].map((z) => px((z as HTMLElement).style.height));
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

describe('the proposed tokens obey their rules', () => {
  it('text rungs are 15 + [−4 … +2]; display rungs are 2·round(16·1.25ⁿ/2)', () => {
    const px = TYPE_LADDER.map((t) => t.px);
    expect(px.slice(0, 6)).toEqual([-4, -3, -2, -1, 0, 2].map((o) => 15 + o));
    expect(px.slice(6)).toEqual([1, 2, 3, 5].map((n) => 2 * Math.round((16 * 1.25 ** n) / 2)));
  });

  it('durations are perception × 1.2 × [1, 5/3, 8/3, 4, 7.5]', () => {
    expect(PERCEPTION_MS).toBe(100);
    expect(DUR_MS).toEqual([120, 200, 320, 480, 900]);
  });

  it('every text token reaches 4.5:1 on every surface', () => {
    for (const t of TEXT_TOKENS) {
      for (const s of SURFACES) {
        expect({ pair: `${t}/${s}`, ok: contrast(PALETTE[t], PALETTE[s]) >= 4.5 }).toEqual({ pair: `${t}/${s}`, ok: true });
      }
    }
  });

  it('the board root carries every one of them', () => {
    const root = renderBoard('tokens', 1024).querySelector<HTMLElement>('.db') as HTMLElement;
    const declared = tokenStyle()
      .split(';')
      .map((d) => [d.slice(0, d.indexOf(':')), d.slice(d.indexOf(':') + 1)] as const);
    expect(declared.length).toBeGreaterThan(50);
    for (const [name, value] of declared) expect([name, root.style.getPropertyValue(name).trim()]).toEqual([name, value]);
    expect(root.style.getPropertyValue('--fs-body').trim()).toBe('15px');
    expect(root.style.getPropertyValue('--faint').trim()).toBe('#8e8e97');
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
