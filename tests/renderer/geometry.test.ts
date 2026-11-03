/**
 * L-GEOMETRY (spec §12.6): the window geometry has one home, the kernel's
 * `SHELL_GEOMETRY`. The renderer may not import the kernel, so its copies —
 * `shell.css` and the direction boards' layout — are pinned to it here.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { SHELL_GEOMETRY } from '@/kernel/shell-geometry';
import { BAND_H, SIDEBAR_W } from '@/renderer/gallery/direction/layout';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const SHELL_CSS = read('src/renderer/styles/shell.css');

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect({ selector, found: at >= 0 }).toEqual({ selector, found: true });
  return css.slice(at, css.indexOf('}', at));
}

describe('shell.css draws the kernel geometry', () => {
  it('the column is SIDEBAR_WIDTH_PX wide', () => {
    expect(rule(SHELL_CSS, '.shell > .console')).toContain(`flex: 0 0 ${SHELL_GEOMETRY.SIDEBAR_WIDTH_PX}px;`);
  });

  it('the stage bar is STAGE_BAR_HEIGHT_PX tall, the y where the Instagram view starts', () => {
    const bar = rule(SHELL_CSS, '.stagebar');
    expect(bar).toContain(`flex: 0 0 ${SHELL_GEOMETRY.STAGE_BAR_HEIGHT_PX}px;`);
    expect(bar).toContain(`height: ${SHELL_GEOMETRY.STAGE_BAR_HEIGHT_PX}px;`);
  });

  it('the comments name the real home, not a file that holds no geometry', () => {
    expect(SHELL_CSS).not.toMatch(/src\/main\/main\.ts/);
    expect(SHELL_CSS).toContain('src/kernel/shell-geometry.ts');
  });
});

describe('every other copy agrees', () => {
  it('the direction boards lay the window out on the same numbers', () => {
    expect(SIDEBAR_W).toBe(SHELL_GEOMETRY.SIDEBAR_WIDTH_PX);
    expect(BAND_H).toBe(SHELL_GEOMETRY.STAGE_BAR_HEIGHT_PX);
  });

  it('the window shell reads the kernel, never a literal of its own', () => {
    const shell = read('src/main/window/shell.ts');
    expect(shell).toContain("from '@/kernel/shell-geometry'");
    expect(shell).not.toMatch(/=\s*(460|44|500);/);
  });
});

describe('SHELL_GEOMETRY is a guarded tier-1 table', () => {
  it('each entry carries a one-line guard comment', () => {
    const lines = read('src/kernel/shell-geometry.ts').split('\n').map((l) => l.trim());
    const keys = Object.keys(SHELL_GEOMETRY);
    for (const key of keys) {
      const at = lines.findIndex((l) => l.startsWith(`${key}:`));
      const above = lines[at - 1] ?? '';
      expect({ key, guarded: above.startsWith('/**') && above.endsWith('*/') && above.includes('Guards:') }).toEqual({
        key,
        guarded: true,
      });
    }
    expect(keys).toEqual(['SIDEBAR_WIDTH_PX', 'STAGE_BAR_HEIGHT_PX', 'BOUNDS_PERSIST_MS']);
  });
});
