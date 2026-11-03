/**
 * The Epo design scale — the DERIVED half of the design tokens (ADR 0405).
 *
 * Everything here is a number with a rule behind it: the spacing ramp, the
 * semantic type ladder, and the control-size ramp. `renderTokensCss()` turns
 * them into `src/renderer/styles/tokens.generated.css`; `scripts/gen-tokens.mjs`
 * is a thin CLI over that function and `tests/renderer/tokens.test.ts` fails the
 * gate when the committed stylesheet drifts from this module.
 *
 * The PALETTE is deliberately NOT here. Colors, radii, hairlines, fills,
 * gradients, elevation and motion are judgement calls with no generating rule
 * (or, for motion, a rule pinned in `motion-scale.ts`), so they stay in
 * `tokens.palette.css`.
 *
 * No imports: the module is loaded both by the renderer and by the generator,
 * which transpiles this one file in isolation.
 */

/* ========================================================================== *
 * SPACING
 * ========================================================================== */

/** The spacing unit. The ramp's mid-values are LINEAR multiples of it. */
export const BASE_SPACE_PX = 4;

/**
 * The multipliers of {@link BASE_SPACE_PX}, `--sp-0` through `--sp-8`. The
 * refresh adds 8 and 10 (32 and 40 px) for the roomier console; the first
 * seven keep their values.
 */
export const SPACE_STEPS = [0.5, 1, 2, 3, 4, 5, 6, 8, 10] as const;

/** The lower clamp shoulder: `0.75 × mid` (how far a step compresses on a narrow pane). */
export const SPACE_MIN_RATIO = 0.75;

/** The upper clamp shoulder: `floor(1.125 × mid)` (how far a step breathes on a wide pane). */
export const SPACE_MAX_RATIO = 1.125;

/**
 * Upper-shoulder overrides, by step index. At the two smallest steps
 * `floor(1.125 × mid)` collapses onto the mid itself (`floor(2.25) = 2`,
 * `floor(4.5) = 4`), leaving no room to grow; those two breathe to `1.25 × mid`.
 */
export const SPACE_MAX_RATIO_OVERRIDES: Readonly<Record<number, number>> = {
  0: 1.25, // --sp-0: floor(1.125 × 2) = 2 would equal the mid → 2.5px
  1: 1.25, // --sp-1: floor(1.125 × 4) = 4 would equal the mid → 5px
};

/**
 * The viewport width the root ramp's preferred `vw` value is expressed against
 * (`mid × 100 / DESIGN_WIDTH_PX`, at most three decimals). FITTED: the only width
 * at which the first seven preferred values round to their shipped figures.
 */
export const DESIGN_WIDTH_PX = 1240.5;

/**
 * The container width the console ramp's preferred `cqi` value is expressed
 * against (`mid × 100 / CONSOLE_WIDTH_PX`, at most two decimals). The console
 * and every stage page and column are size containers, so their rhythm tracks
 * the pane's width rather than the page's. Also FITTED.
 */
export const CONSOLE_WIDTH_PX = 470.5;

/** `--sp-5` ships as `4.26cqi` where the rule gives `4.25` (≈ 0.05 px); kept so no pixel moves. */
export const CONSOLE_CQI_OVERRIDES: Readonly<Record<number, string>> = {
  5: '4.26',
};

/* ========================================================================== *
 * TYPE — one semantic ladder (spec §12.6)
 * ========================================================================== */

/** The body size every text rung is anchored on — `--fs-body`. */
export const BODY_FONT_PX = 15;

/** Text rungs: `BODY_FONT_PX + offset`, from the axis tick up to the now line. */
export const TEXT_OFFSETS = [-4, -3, -2, -1, 0, 2] as const;
export const TEXT_NAMES = ['micro', 'caption', 'small', 'label', 'body', 'lead'] as const;

/** Display rungs: `2·round(16·1.25ⁿ/2)` — the major-third steps, on even pixels. */
export const DISPLAY_BASE_PX = 16;
export const DISPLAY_RATIO = 1.25;
export const DISPLAY_STEPS = [1, 2, 3, 5] as const;
export const DISPLAY_NAMES = ['title', 'heading', 'state', 'hero'] as const;

/** What each rung is for, in the emitted stylesheet's trailing comment. */
const TYPE_NOTES: Readonly<Record<string, string>> = {
  micro: 'axis ticks, badge counts — never a sentence',
  caption: 'timestamps, group headers, meta',
  small: 'secondary lines, hints, chips, the next line',
  label: 'control labels, stage tabs, feed sentences',
  body: 'body, inputs, buttons, zone titles',
  lead: 'the now line, the wordmark, section leads',
  title: 'section and column titles',
  heading: 'page titles, the compact posture word',
  state: 'the posture word',
  hero: 'the one hero number',
};

/* ========================================================================== *
 * CONTROL SIZES
 * ========================================================================== */

/** The shortest control height — `--h-xs`, the smallest hit target (spec §12.6). */
export const BASE_CONTROL_PX = 32;

/** The rung spacing of the control ramp: `--h-xs/sm/md/lg = 32 + 4n`. */
export const CONTROL_STEP_PX = 4;

export const CONTROL_NAMES = ['xs', 'sm', 'md', 'lg'] as const;

const CONTROL_NOTES = [
  'chips, small buttons — the smallest hit target',
  'segments, stage tabs',
  'inputs, steppers, rows',
  'the primary action',
] as const;

/* ========================================================================== *
 * COMPUTED VALUES
 * ========================================================================== */

/** The spacing mid-values, in px, at the design width: `[2 … 40]`. */
export const SPACE_PX: readonly number[] = SPACE_STEPS.map((step) => step * BASE_SPACE_PX);

export const SPACE_MIN_PX: readonly number[] = SPACE_PX.map((mid) => mid * SPACE_MIN_RATIO);

export const SPACE_MAX_PX: readonly number[] = SPACE_PX.map((mid, i) => {
  const override = SPACE_MAX_RATIO_OVERRIDES[i];
  return override === undefined ? Math.floor(mid * SPACE_MAX_RATIO) : mid * override;
});

/** The ten rungs in ascending order, `{ name, px }`: `11 · 12 · 13 · 14 · 15 · 17 · 20 · 26 · 32 · 48`. */
export const TYPE_LADDER: ReadonlyArray<{ name: string; px: number }> = [
  ...TEXT_NAMES.map((name, i) => ({ name, px: BODY_FONT_PX + TEXT_OFFSETS[i] })),
  ...DISPLAY_NAMES.map((name, i) => ({
    name,
    px: 2 * Math.round((DISPLAY_BASE_PX * DISPLAY_RATIO ** DISPLAY_STEPS[i]) / 2),
  })),
];

/** The four control heights, in px: `[32, 36, 40, 44]`. */
export const CONTROL_PX: readonly number[] = CONTROL_NAMES.map(
  (_, i) => BASE_CONTROL_PX + i * CONTROL_STEP_PX,
);

/* ========================================================================== *
 * EMITTER
 * ========================================================================== */

/** Print a number with AT MOST `decimals` places, trailing zeros stripped. */
const num = (value: number, decimals: number): string => {
  const fixed = value.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
};

/** One custom-property declaration, with an optional trailing role comment. */
const decl = (name: string, value: string, note?: string): string =>
  `  --${name}: ${value};${note === undefined ? '' : ` /* ${note} */`}`;

/** The spacing ramp expressed against the viewport width (`vw`, root scope). */
const rootSpaceRamp = (): string[] =>
  SPACE_PX.map((mid, i) => {
    const preferred = num((mid * 100) / DESIGN_WIDTH_PX, 3);
    return decl(`sp-${i}`, `clamp(${num(SPACE_MIN_PX[i], 3)}px, ${preferred}vw, ${num(SPACE_MAX_PX[i], 3)}px)`);
  });

/** The same ramp expressed against the container's inline size (`cqi`). */
const consoleSpaceRamp = (): string[] =>
  SPACE_PX.map((mid, i) => {
    const preferred = CONSOLE_CQI_OVERRIDES[i] ?? num((mid * 100) / CONSOLE_WIDTH_PX, 2);
    return decl(`sp-${i}`, `clamp(${num(SPACE_MIN_PX[i], 3)}px, ${preferred}cqi, ${num(SPACE_MAX_PX[i], 3)}px)`);
  });

/**
 * The complete generated stylesheet, as text. Pure: same output every call,
 * no I/O. `scripts/gen-tokens.mjs` writes it; the test compares against it.
 */
export function renderTokensCss(): string {
  const lines: string[] = [
    '/*',
    ' * GENERATED — do not edit. Edit `src/renderer/design/scale.ts` and run',
    ' * `npm run gen:tokens`. `tests/renderer/tokens.test.ts` fails the gate when',
    ' * this file drifts from the scale module.',
    ' *',
    ' * The derived half of the Epo design tokens (ADR 0405): the spacing ramp, the',
    ' * semantic type ladder and the control-size ramp. The palette, radii, motion',
    ' * and every other judgement call stay in `tokens.palette.css`.',
    ' */',
    '',
    ':root {',
    '  /* ============ TYPE (semantic ladder) ============',
    `     Text rungs ${BODY_FONT_PX}px + [${TEXT_OFFSETS.join(', ')}]; display rungs`,
    `     2·round(${DISPLAY_BASE_PX}·${DISPLAY_RATIO}ⁿ/2) for n ∈ {${DISPLAY_STEPS.join(', ')}}. No fluid type. */`,
  ];
  for (const rung of TYPE_LADDER) lines.push(decl(`fs-${rung.name}`, `${rung.px}px`, TYPE_NOTES[rung.name]));

  lines.push(
    '',
    `  /* ============ SPACING (derived — ${BASE_SPACE_PX}px × [${SPACE_STEPS.join(', ')}]) ============`,
    '     Fluid: tracks the viewport, compresses on small panes, breathes a touch',
    '     on large ones. Each size container re-declares it against its own width. */',
    ...rootSpaceRamp(),
    '',
    `  /* ============ CONTROL SIZES (derived — ${BASE_CONTROL_PX} + ${CONTROL_STEP_PX}n) ============ */`,
  );
  CONTROL_NAMES.forEach((name, i) => {
    lines.push(decl(`h-${name}`, `${CONTROL_PX[i]}px`, CONTROL_NOTES[i]));
  });

  lines.push(
    '}',
    '',
    '/* The console, every stage page and each of its columns are size containers',
    '   (see shell.css), so the SAME ramp resolves against their inline size: identical',
    `   px at the ${CONSOLE_WIDTH_PX}px container design width, following the pane, not the page. */`,
    '.console,',
    '.stage-page,',
    '.stage-col {',
    ...consoleSpaceRamp(),
    '}',
    '',
  );

  return lines.join('\n');
}
