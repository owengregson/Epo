/**
 * L-CONTRAST (spec §12.6, ADR 0405): every text token in `tokens.palette.css`
 * reaches WCAG 2 AA (4.5:1) on every surface it can sit on, measured from the
 * stylesheet itself; the direction boards show the same palette.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PALETTE } from '@/renderer/gallery/direction/proposed-tokens';

const CSS = readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles', 'tokens.palette.css'), 'utf8');

/** Every `--name: #rrggbb;` the palette declares. */
const HEX = new Map([...CSS.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1] as string, (m[2] as string).toLowerCase()]));

const SURFACES = ['--bg', '--surface', '--elevated', '--chip-bg', '--track-bg', '--active-fill'];
const TEXT = ['--text', '--muted', '--faint', '--silver', '--chrome', '--live', '--warn', '--danger', '--ok'];

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('L-CONTRAST', () => {
  it('reads every text token and surface from the stylesheet', () => {
    for (const name of [...SURFACES, ...TEXT]) expect({ name, declared: HEX.has(name) }).toEqual({ name, declared: true });
  });

  it.each(TEXT)('%s reaches 4.5:1 on every surface', (text) => {
    for (const surface of SURFACES) {
      const r = ratio(HEX.get(text) as string, HEX.get(surface) as string);
      expect({ pair: `${text} on ${surface}`, aa: r >= 4.5 }).toEqual({ pair: `${text} on ${surface}`, aa: true });
    }
  });

  it('the three reopened values are the measured ones', () => {
    expect([HEX.get('--faint'), HEX.get('--muted'), HEX.get('--danger')]).toEqual(['#8e8e97', '#a8a8b0', '#d27878']);
  });

  it('the WCAG arithmetic is right (black on white is 21:1, a colour on itself 1:1)', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(ratio('#8e8e97', '#8e8e97')).toBe(1);
  });

  it('the direction boards show exactly this palette', () => {
    for (const [key, value] of Object.entries(PALETTE)) expect([key, HEX.get(`--${key}`)]).toEqual([key, value]);
  });
});
