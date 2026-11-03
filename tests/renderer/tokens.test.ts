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
 *  2. GOLDEN — the declarations the scale emits must still be the ones that
 *     SHIPPED before the ramp was generated. The expected strings below are
 *     hard-coded from the pre-split `styles/tokens.css` and `styles/shell.css`,
 *     deliberately NOT read back from any file: this table is the record of the
 *     approved mockup's values, and a scale change that moves a rendered pixel
 *     has to update it in the same commit, on purpose.
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

describe('the generated tokens reproduce the shipped values', () => {
  /** The root spacing ramp — `4px × [0.5,1,2,3,4,5,6]`, fluid against the viewport. */
  const spacing = [
    '--sp-0: clamp(1.5px, 0.161vw, 2.5px);',
    '--sp-1: clamp(3px, 0.322vw, 5px);',
    '--sp-2: clamp(6px, 0.645vw, 9px);',
    '--sp-3: clamp(9px, 0.967vw, 13px);',
    '--sp-4: clamp(12px, 1.29vw, 18px);',
    '--sp-5: clamp(15px, 1.612vw, 22px);',
    '--sp-6: clamp(18px, 1.935vw, 27px);',
  ];

  /** The static type ladder — `12px + [-3.5,-3,-2,-1,0,1,3]`. */
  const type = [
    '--fs-2xs: 8.5px;',
    '--fs-xs: 9px;',
    '--fs-sm: 10px;',
    '--fs-md: 11px;',
    '--fs-base: 12px;',
    '--fs-lg: 13px;',
    '--fs-xl: 15px;',
  ];

  /** The container-tracking type clamps — hand-tuned per role, carried verbatim. */
  const fluidType = [
    '--fs-fluid-cap: clamp(9px, 2.13cqi, 10.5px);',
    '--fs-fluid-title: clamp(12.5px, 2.98cqi, 15px);',
    '--fs-fluid-handle: clamp(13.5px, 3.3cqi, 16px);',
    '--fs-fluid-stat: clamp(13px, 3.4cqi, 17px);',
    '--fs-fluid-display: clamp(19px, 5.53cqi, 28px);',
    '--fs-fluid-hero: clamp(24px, 7.23cqi, 36px);',
  ];

  /** The same ramp re-declared against the console container's inline size. */
  const consoleSpacing = [
    '--sp-0: clamp(1.5px, 0.43cqi, 2.5px);',
    '--sp-1: clamp(3px, 0.85cqi, 5px);',
    '--sp-2: clamp(6px, 1.7cqi, 9px);',
    '--sp-3: clamp(9px, 2.55cqi, 13px);',
    '--sp-4: clamp(12px, 3.4cqi, 18px);',
    '--sp-5: clamp(15px, 4.26cqi, 22px);',
    '--sp-6: clamp(18px, 5.1cqi, 27px);',
  ];

  /** The control-height ramp — `24 + 2n` — plus the off-ramp ticker bar. */
  const controls = [
    '--h-xs: 24px;',
    '--h-sm: 26px;',
    '--h-md: 28px;',
    '--h-lg: 30px;',
    '--h-ticker: 34px;',
  ];

  test.each(spacing)('root spacing: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test.each(type)('type ladder: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test.each(fluidType)('fluid type: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test.each(consoleSpacing)('console spacing: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test.each(controls)('control size: %s', (declaration) => {
    expect(css).toContain(declaration);
  });

  test('the console ramp lands on the console selector list, not :root', () => {
    const [root, container] = css.split('.console,\n.prune-page,\n.prune-col {');
    expect(container).toBeDefined();
    for (const declaration of consoleSpacing) expect(container).toContain(declaration);
    for (const declaration of spacing) expect(root).toContain(declaration);
    // The viewport ramp must NOT leak into the container block, or the console
    // would track the page width again.
    for (const declaration of spacing) expect(container).not.toContain(declaration);
  });

  test('nothing else declares a spacing, type or control token (generated block)', () => {
    const declared = [...css.matchAll(/^ {2}(--[\w-]+):/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(
      [
        ...spacing.map((d) => d.slice(0, d.indexOf(':'))),
        ...spacing.map((d) => d.slice(0, d.indexOf(':'))),
        ...type.map((d) => d.slice(0, d.indexOf(':'))),
        ...fluidType.map((d) => d.slice(0, d.indexOf(':'))),
        ...controls.map((d) => d.slice(0, d.indexOf(':'))),
      ].sort(),
    );
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
