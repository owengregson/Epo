/**
 * The live column's sheets keep the motion laws (spec §12.7, ADR 0405): every transition and animation runs
 * on a duration token, the column has one infinite loop of its own (the mark's breath; the Live tab's dot
 * is the shell's second), reduced motion stops it, and nothing is set in capitals. The inline splash's one
 * loop is its shimmer, which reduced motion hides.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const STYLES = path.resolve(__dirname, '../../src/renderer/styles');
const sheet = (name: string): string => fs.readFileSync(path.join(STYLES, name), 'utf8');
const SHEETS = ['sidebar.css', 'boot.css', 'diagnostics.css'];

/** The time values inside every transition / animation declaration. */
function literalDurations(css: string): string[] {
  return [...css.matchAll(/(?:transition|animation)(?:-duration|-delay)?\s*:([^;{}]*);/g)].flatMap((m) =>
    [...(m[1] as string).matchAll(/(?<![\w.-])\d*\.?\d+m?s\b/g)].map((x) => x[0]),
  );
}

describe('the live sheets', () => {
  it.each(SHEETS)('%s times every motion with a token', (name) => {
    expect(literalDurations(sheet(name)).filter((d) => d !== '0s' && d !== '0.01ms')).toEqual([]);
  });

  it.each(SHEETS)('%s sets nothing in capitals', (name) => {
    expect(/text-transform:\s*uppercase/.test(sheet(name))).toBe(false);
  });

  it('the column has exactly one loop of its own, and reduced motion stops it', () => {
    const css = sheet('sidebar.css');
    expect(css.match(/\binfinite\b/g)).toHaveLength(1);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.sb-mast\[data-tone="live"\] \.sb-mast__mark::after\s*\{\s*animation: none;/);
  });

  it("the splash's shimmer is its only loop, hidden under reduced motion", () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
    expect(html.match(/\binfinite\b/g)).toHaveLength(1);
    expect(html).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\}\s*#boot \.boot-shimmer::after \{ display: none; \}/);
    expect(literalDurations(html)).toEqual([]);
  });
});

test('the visible app has at most two infinite CSS loops, including loading skeletons', () => {
  const sheets = fs.readdirSync(STYLES).filter((file) => file.endsWith('.css') && file !== 'boot.css');
  const loops = sheets.flatMap((name) => [...sheet(name).matchAll(/animation(?:-iteration-count)?\s*:[^;{}]*\binfinite\b/g)]);
  expect(loops.length).toBeLessThanOrEqual(2);
  expect(sheet('shell.css')).toMatch(/\.stagebar \[data-tip\]::after\s*\{\s*content: none;/);
});


test('the eager graph stays measurable but invisible before selection', () => {
  const shell = sheet('shell.css');
  const hiddenGraph = shell.match(/\.stage-view\[data-stage="graph"\]\[hidden\]\s*\{([^}]+)\}/)?.[1];
  expect(hiddenGraph).toMatch(/display: block/);
  expect(hiddenGraph).toMatch(/visibility: hidden/);
  expect(hiddenGraph).toMatch(/pointer-events: none/);
  const graph = sheet('graph.css').match(/\.graph-stage\s*\{([^}]+)\}/)?.[1];
  expect(graph).toMatch(/display: block/);
});


test('the graph failure retry accepts pointer input over the pass-through message layer', () => {
  expect(sheet('graph.css')).toMatch(/\.graph-empty button\s*\{\s*pointer-events: auto;/);
});
