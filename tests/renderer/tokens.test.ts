/**
 * Gate on the generated design tokens.
 *
 * Two independent guarantees:
 *
 *  1. FRESHNESS — `renderTokensCss()` must equal the committed
 *     `styles/tokens.generated.css` byte-for-byte. The stylesheet is checked in
 *     so the app and this suite need no codegen pass; that is exactly what lets
 *     it go stale the moment anyone edits `design/scale.ts`.
 *
 *  2. GOLDEN — the declarations the scale emits are the approved values of the
 *     refresh (ADR 0405, spec §12.6): the semantic type ladder, the spacing ramp
 *     with its 32/40 rungs, and controls 32 + 4n. The strings below are written
 *     out, deliberately NOT read back from any file: a scale change that moves a
 *     rendered pixel has to update this table in the same commit, on purpose.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { renderTokensCss } from '@/renderer/design/scale';

const GENERATED = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'renderer',
  'styles',
  'tokens.generated.css',
);

const css = renderTokensCss();

describe('the committed stylesheet is fresh', () => {
  test('it is byte-for-byte what the scale renders', () => {
    // Stale? Run `node scripts/gen-tokens.mjs`.
    expect(readFileSync(GENERATED, 'utf8')).toBe(css);
  });
});

describe('the generated tokens are the approved scale (ADR 0405)', () => {
  /** The root spacing ramp — `4px × [0.5, 1, 2, 3, 4, 5, 6, 8, 10]`, fluid against the viewport. */
  const spacing = [
    '--sp-0: clamp(1.5px, 0.161vw, 2.5px);',
    '--sp-1: clamp(3px, 0.322vw, 5px);',
    '--sp-2: clamp(6px, 0.645vw, 9px);',
    '--sp-3: clamp(9px, 0.967vw, 13px);',
    '--sp-4: clamp(12px, 1.29vw, 18px);',
    '--sp-5: clamp(15px, 1.612vw, 22px);',
    '--sp-6: clamp(18px, 1.935vw, 27px);',
    '--sp-7: clamp(24px, 2.58vw, 36px);',
    '--sp-8: clamp(30px, 3.225vw, 45px);',
  ];

  /** The semantic ladder: text rungs `15 + [−4, −3, −2, −1, 0, +2]`, display `2·round(16·1.25ⁿ/2)`. */
  const type = [
    '--fs-micro: 11px;',
    '--fs-caption: 12px;',
    '--fs-small: 13px;',
    '--fs-label: 14px;',
    '--fs-body: 15px;',
    '--fs-lead: 17px;',
    '--fs-title: 20px;',
    '--fs-heading: 26px;',
    '--fs-state: 32px;',
    '--fs-hero: 48px;',
  ];

  /** The same ramp re-declared against each size container's inline size. */
  const consoleSpacing = [
    '--sp-0: clamp(1.5px, 0.43cqi, 2.5px);',
    '--sp-1: clamp(3px, 0.85cqi, 5px);',
    '--sp-2: clamp(6px, 1.7cqi, 9px);',
    '--sp-3: clamp(9px, 2.55cqi, 13px);',
    '--sp-4: clamp(12px, 3.4cqi, 18px);',
    '--sp-5: clamp(15px, 4.26cqi, 22px);',
    '--sp-6: clamp(18px, 5.1cqi, 27px);',
    '--sp-7: clamp(24px, 6.8cqi, 36px);',
    '--sp-8: clamp(30px, 8.5cqi, 45px);',
  ];

  /** The control-height ramp — `32 + 4n`; the ticker's off-ramp height is gone. */
  const controls = ['--h-xs: 32px;', '--h-sm: 36px;', '--h-md: 40px;', '--h-lg: 44px;'];

  test.each(spacing)('root spacing: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test.each(type)('type ladder: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test.each(consoleSpacing)('container spacing: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test.each(controls)('control size: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test('the container ramp lands on the console and the stage pages, not :root', () => {
    const [root, container] = css.split('.console,\n.stage-page,\n.stage-col {');
    expect(container).toBeDefined();
    for (const declaration of consoleSpacing) expect(container).toContain(declaration);
    for (const declaration of spacing) expect(root).toContain(declaration);
    for (const declaration of spacing) expect(container).not.toContain(declaration);
  });

  test('no fluid type is left, and nothing else declares a spacing, type or control token', () => {
    expect(css).not.toMatch(/--fs-fluid|cqi, \d+(\.\d+)?px\);\s*\/\* .*(title|hero|stat)/);
    const declared = [...css.matchAll(/^ {2}(--[\w-]+):/gm)].map((m) => m[1]);
    const names = (list: string[]): string[] => list.map((d) => d.slice(0, d.indexOf(':')));
    expect(declared.sort()).toEqual([...names(spacing), ...names(spacing), ...names(type), ...names(controls)].sort());
  });

  test('the rules hold: text rungs around the 15 px body, display rungs on the major third', () => {
    const px = type.map((d) => Number.parseFloat(d.slice(d.indexOf(':') + 1)));
    expect(px.slice(0, 6)).toEqual([-4, -3, -2, -1, 0, 2].map((o) => 15 + o));
    expect(px.slice(6)).toEqual([1, 2, 3, 5].map((n) => 2 * Math.round((16 * 1.25 ** n) / 2)));
  });
});

/** Every stylesheet the renderer loads through `styles/index.css`, comments stripped. */
function sheets(): Array<{ file: string; css: string }> {
  const dir = path.join(__dirname, '..', '..', 'src', 'renderer', 'styles');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .map((file) => ({ file, css: readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));
}

/** `var(--name)` reads with no fallback; a fallback marks a property set inline from a component. */
const bareReads = (css: string): string[] =>
  [...css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)].filter((m) => m[2] === undefined).map((m) => m[1] as string);

describe('L-TOKENS: every token a stylesheet reads is declared', () => {
  test('each bare var(--name) is declared in some sheet', () => {
    const all = sheets();
    const declared = new Set(all.flatMap(({ css }) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])));
    const undeclared = all.flatMap(({ file, css }) =>
      bareReads(css)
        .filter((name) => !declared.has(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(undeclared).toEqual([]);
  });

  test('the check sees a typo’d token and lets an inline-set one with a fallback through', () => {
    expect(bareReads('.a { color: var(--txet); } .b { width: var(--w, 0); }')).toEqual(['--txet']);
  });
});
