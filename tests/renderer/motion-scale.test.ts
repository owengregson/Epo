/**
 * @jest-environment jsdom
 *
 * L-MOTION (spec §12.7, ADR 0405): the renderer's presentation timings are one
 * rule over perception, its perception unit is the kernel's, the CSS tokens say
 * the same numbers as `motion-scale.ts`, and the section cascade plays them.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { EMPIRICAL } from '@/kernel/fundamentals';
import {
  BOOT_UI,
  BREATH_MS,
  CHART_DEFAULT_DAYS,
  DUR,
  DUR_STEPS,
  PERCEPTION_MS,
  STAGGER_MS,
} from '@/renderer/design/motion-scale';
import { EASE, EASE_IN_OUT, EASE_OUT } from '@/renderer/lib/motion';
import { staggerSections } from '@/renderer/lib/stagger';

const PALETTE_CSS = readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'styles', 'tokens.palette.css'),
  'utf8',
);
const token = (name: string): string => new RegExp(`${name}:\\s*([^;]+);`).exec(PALETTE_CSS)?.[1]?.trim() ?? '';

describe('L-MOTION: one rule over perception', () => {
  it('PERCEPTION_MS is the kernel’s display perception unit', () => {
    expect(PERCEPTION_MS).toBe(EMPIRICAL.DISPLAY.perceptionMs);
  });

  it('DUR = PERCEPTION_MS × 1.2 × [1, 5/3, 8/3, 4, 7.5] = 120 · 200 · 320 · 480 · 900', () => {
    expect(DUR_STEPS).toEqual([1, 5 / 3, 8 / 3, 4, 7.5]);
    expect([DUR[1], DUR[2], DUR[3], DUR[4], DUR[5]]).toEqual([120, 200, 320, 480, 900]);
  });

  it('the breath, the stagger and the splash timings are perception multiples', () => {
    expect(BREATH_MS).toBe(26 * PERCEPTION_MS);
    expect(STAGGER_MS).toBe(60);
    expect(BOOT_UI).toEqual({ MIN_SPLASH_MS: 600, CAPTION_DELAY_MS: 1200, SLOW_COPY_MS: 2500 });
    expect(BOOT_UI.MIN_SPLASH_MS < BOOT_UI.CAPTION_DELAY_MS && BOOT_UI.CAPTION_DELAY_MS < BOOT_UI.SLOW_COPY_MS).toBe(true);
    expect(CHART_DEFAULT_DAYS).toBe(14);
  });
});

describe('L-MOTION: the CSS tokens say the same', () => {
  it.each([1, 2, 3, 4, 5] as const)('--dur-%i is DUR[%i] ms', (n) => {
    expect(token(`--dur-${n}`)).toBe(`${DUR[n]}ms`);
  });

  it('--breath is BREATH_MS', () => {
    expect(token('--breath')).toBe(`${BREATH_MS}ms`);
  });

  it('the three curves match lib/motion', () => {
    expect([token('--ease'), token('--ease-out'), token('--ease-in-out')]).toEqual([EASE, EASE_OUT, EASE_IN_OUT]);
  });
});

describe('staggerSections', () => {
  function page(n: number): { host: HTMLElement; calls: Array<{ el: Element; opts: KeyframeAnimationOptions }> } {
    const host = document.createElement('div');
    const calls: Array<{ el: Element; opts: KeyframeAnimationOptions }> = [];
    for (let i = 0; i < n; i++) {
      const section = document.createElement('section');
      Object.assign(section, {
        animate: (_frames: Keyframe[], opts: KeyframeAnimationOptions) => {
          calls.push({ el: section, opts });
          return {} as Animation;
        },
        getAnimations: () => [],
      });
      host.appendChild(section);
    }
    return { host, calls };
  }

  it('each top-level section arrives over DUR[3], STAGGER_MS after the one before, capped', () => {
    const { host, calls } = page(10);
    staggerSections(host);
    expect(calls.map((c) => c.opts.duration)).toEqual(Array(10).fill(DUR[3]));
    expect(calls.map((c) => c.opts.delay)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 8].map((i) => i * STAGGER_MS));
    expect(calls.every((c) => c.opts.easing === EASE_OUT && c.opts.fill === 'both')).toBe(true);
  });

  it('does nothing without a host or where animation is unavailable', () => {
    expect(() => staggerSections(null)).not.toThrow();
    const host = document.createElement('div');
    host.appendChild(document.createElement('section'));
    expect(() => staggerSections(host)).not.toThrow();
  });
});
