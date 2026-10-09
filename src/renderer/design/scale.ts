/**
 * The Epo design scale — the DERIVED half of the design tokens.
 *
 * Everything here is a number with a rule behind it: the spacing ramp, the
 * type ladder, and the control-size ramp. `renderTokensCss()` turns them into
 * `src/renderer/styles/tokens.generated.css`; `scripts/gen-tokens.mjs` is a
 * thin CLI over that function and `tests/renderer/tokens.test.ts` fails the
 * gate when the committed stylesheet drifts from this module.
 *
 * The PALETTE is deliberately NOT here. Colors, radii, hairlines, fills,
 * gradients and elevation are judgement calls with no generating rule, so they
 * stay hand-authored in `tokens.palette.css`.
 *
 * Every constant below was FITTED to the approved mockup's shipped values, not
 * chosen and then rounded to: the emitted stylesheet reproduces the previous
 * hand-written `tokens.css` byte-for-byte on every declaration. Where a shipped
 * value does not fall out of its rule, it is carried as an explicit override
 * table with the reason written next to it, rather than being smoothed away —
 * introducing the scale had to be a pure move, not a retune.
 *
 * No imports: the module is loaded both by the renderer (for canvas layout that
 * needs the same numbers in JS) and by the generator, which transpiles this one
 * file in isolation.
 */

/* ========================================================================== *
 * SPACING
 * ========================================================================== */

/**
 * The spacing unit. The ramp's mid-values are LINEAR multiples of it — not a
 * geometric progression: `sp-0..6 = 4 × [0.5, 1, 2, 3, 4, 5, 6]`.
 */
export const BASE_SPACE_PX = 4;

/** The seven multipliers of {@link BASE_SPACE_PX}, `--sp-0` through `--sp-6`. */
export const SPACE_STEPS = [0.5, 1, 2, 3, 4, 5, 6] as const;

/**
 * The lower clamp shoulder: how far a step compresses on a narrow viewport.
 * `0.75 × mid` reproduces all seven shipped minimums exactly.
 */
export const SPACE_MIN_RATIO = 0.75;

/**
 * The upper clamp shoulder: how far a step breathes on a wide viewport.
 * `floor(1.125 × mid)` reproduces `--sp-2` through `--sp-6` exactly.
 */
export const SPACE_MAX_RATIO = 1.125;

/**
 * Upper-shoulder overrides, by step index.
 *
 * At the two smallest steps `floor(SPACE_MAX_RATIO × mid)` collapses onto the
 * mid itself — `floor(2.25) = 2` and `floor(4.5) = 4` — which would leave the
 * token with no room to grow and stop it being fluid at all. The mockup widened
 * exactly those two shoulders to `1.25 × mid`, giving the shipped `2.5px` and
 * `5px`. Kept as data, not folded into the rule: the ratio only changes because
 * flooring runs out of resolution down there.
 */
export const SPACE_MAX_RATIO_OVERRIDES: Readonly<Record<number, number>> = {
  0: 1.25, // --sp-0: floor(1.125 × 2) = 2 would equal the mid → 1.25 × 2 = 2.5px
  1: 1.25, // --sp-1: floor(1.125 × 4) = 4 would equal the mid → 1.25 × 4 = 5px
};

/**
 * The viewport width, in px, that the root ramp's preferred `vw` value is
 * expressed against: `mid × 100 / DESIGN_WIDTH_PX`, printed to at most three
 * decimals. FITTED, not chosen — 1240.5 is the only width at which all seven
 * preferred values round to the shipped `0.161 · 0.322 · 0.645 · 0.967 · 1.29 ·
 * 1.612 · 1.935`.
 */
export const DESIGN_WIDTH_PX = 1240.5;

/**
 * The container width, in px, that the console ramp's preferred `cqi` value is
 * expressed against: `mid × 100 / CONSOLE_WIDTH_PX`, printed to at most two
 * decimals. Also FITTED. The console (and the Prune page and its columns) is a
 * size container, so its cards keep the root ramp's px rhythm at the design
 * width while tracking the PANE's width rather than the page's.
 */
export const CONSOLE_WIDTH_PX = 470.5;

/**
 * Console-ramp preferred-value overrides, by step index.
 *
 * The shipped `--sp-5` reads `4.26cqi` where the derivation gives `4.25cqi` —
 * a 0.01cqi hand-value (≈0.05px at the container design width) that nothing in
 * the ramp explains. Preserved verbatim so introducing the scale changes no
 * rendered pixel; drop it and the ramp becomes uniform.
 */
export const CONSOLE_CQI_OVERRIDES: Readonly<Record<number, string>> = {
  5: '4.26',
};

/** What each spacing step is for, in the emitted stylesheet's comment. */
const SPACE_NOTE =
  'The one spacing scale (4px base @ the design width) — fluid: tracks the\n     viewport, compresses on small panes, breathes a touch on large ones.\n     The console root re-declares these against its own inline size.';

/* ========================================================================== *
 * TYPE
 * ========================================================================== */

/** The body size the ladder is anchored on — `--fs-base`. */
export const BASE_FONT_PX = 12;

/**
 * The type ladder is LINEAR too: `--fs-2xs … --fs-xl = BASE_FONT_PX + offset`.
 *
 * It is NOT geometric. No single ratio reproduces the shipped sizes — the
 * step-to-step ratios of `[8.5, 9, 10, 11, 12, 13, 15]` run
 * `1.059 · 1.111 · 1.100 · 1.091 · 1.083 · 1.154`, and the 1.125 "major second"
 * an earlier ideation note assumed would give
 * `[7.49, 8.43, 9.48, 10.67, 12, 13.5, 15.19]`, matching only the anchor.
 */
export const TYPE_OFFSETS = [-3.5, -3, -2, -1, 0, 1, 3] as const;

/** The ladder's rung names, in {@link TYPE_OFFSETS} order. */
export const TYPE_NAMES = ['2xs', 'xs', 'sm', 'md', 'base', 'lg', 'xl'] as const;

/** What each rung is for, in the emitted stylesheet's trailing comment. */
const TYPE_NOTES = [
  'micro badge caps (LOCKED, PRIVATE, pipeline stage labels)',
  'uppercase eyebrows, mono axis/scale labels, badges',
  'hints, legends, chips, ticker, dense meta',
  'small body: log lines, nav, tooltips, sub-lines',
  'body + control text (inputs, kv values, buttons)',
  'document base, emphasized handles',
  'headings, large glyphs, stepper +/-',
] as const;

/**
 * The container-tracking type clamps — HAND-TUNED PER ROLE, not derived.
 *
 * Unlike the spacing ramp these do not share one fitted container width, and
 * cannot: `cap` requires a container in (491.8, 494.1] px while `title`
 * requires (502.5, 504.2] — disjoint intervals, so no single width reproduces
 * both. They live here anyway so that all type lives in one module, and are
 * emitted verbatim with a comment saying they are hand values.
 */
export const FLUID_TYPE = [
  { name: 'cap', min: '9px', preferred: '2.13cqi', max: '10.5px', note: 'card-header eyebrows' },
  { name: 'title', min: '12.5px', preferred: '2.98cqi', max: '15px', note: 'console title' },
  { name: 'handle', min: '13.5px', preferred: '3.3cqi', max: '16px', note: 'target @handle' },
  { name: 'stat', min: '13px', preferred: '3.4cqi', max: '17px', note: 'stat + pipeline numbers' },
  { name: 'display', min: '19px', preferred: '5.53cqi', max: '28px', note: 'growth number' },
  { name: 'hero', min: '24px', preferred: '7.23cqi', max: '36px', note: 'hero countdown' },
] as const;

/* ========================================================================== *
 * CONTROL SIZES
 * ========================================================================== */

/** The shortest control height — `--h-xs`. */
export const BASE_CONTROL_PX = 24;

/** The rung spacing of the control ramp: `--h-xs/sm/md/lg = 24 + 2n`. */
export const CONTROL_STEP_PX = 2;

/** The control ramp's rung names, in ascending order. */
export const CONTROL_NAMES = ['xs', 'sm', 'md', 'lg'] as const;

/** What each control height is for, in the emitted stylesheet's comment. */
const CONTROL_NOTES = [
  'preset chips',
  'segmented-control buttons',
  'number input, stepper',
  'transport buttons, select, text input',
] as const;

/**
 * Named control heights that do NOT sit on the `24 + 2n` ramp.
 *
 * The docked ticker bar is 34px — four rungs above `--h-lg`, and sized by the
 * bar's own content rather than by the control ramp. Emitted as an extra so the
 * ramp stays a clean four steps instead of gaining a fifth it does not have.
 */
export const CONTROL_EXTRAS = [
  { name: 'ticker', px: 34, note: 'docked ticker bar (toasts offset against it)' },
] as const;

/* ========================================================================== *
 * COMPUTED VALUES
 * ========================================================================== */

/** The seven spacing mid-values, in px, at the design width: `[2 … 24]`. */
export const SPACE_PX: readonly number[] = SPACE_STEPS.map((step) => step * BASE_SPACE_PX);

/** The lower clamp shoulder of each spacing step, in px. */
export const SPACE_MIN_PX: readonly number[] = SPACE_PX.map((mid) => mid * SPACE_MIN_RATIO);

/** The upper clamp shoulder of each spacing step, in px (overrides applied). */
export const SPACE_MAX_PX: readonly number[] = SPACE_PX.map((mid, i) => {
  const override = SPACE_MAX_RATIO_OVERRIDES[i];
  return override === undefined ? Math.floor(mid * SPACE_MAX_RATIO) : mid * override;
});

/** The seven type-ladder sizes, in px: `[8.5 … 15]`. */
export const TYPE_PX: readonly number[] = TYPE_OFFSETS.map((offset) => BASE_FONT_PX + offset);

/** The four control heights, in px: `[24, 26, 28, 30]`. */
export const CONTROL_PX: readonly number[] = CONTROL_NAMES.map(
  (_, i) => BASE_CONTROL_PX + i * CONTROL_STEP_PX,
);

/* ========================================================================== *
 * EMITTER
 * ========================================================================== */

/**
 * Print a number with AT MOST `decimals` places, trailing zeros stripped —
 * `1.29` not `1.290`, `3` not `3.000`. CSS treats them identically; the
 * stylesheet reads like something a person wrote.
 */
const num = (value: number, decimals: number): string => {
  const fixed = value.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
};

/** One custom-property declaration, with an optional trailing role comment. */
const decl = (name: string, value: string, note?: string): string =>
  `  --${name}: ${value};${note === undefined ? '' : ` /* ${note} */`}`;

/** The spacing ramp expressed against a viewport width (`vw`, root scope). */
const rootSpaceRamp = (): string[] =>
  SPACE_PX.map((mid, i) => {
    const preferred = num((mid * 100) / DESIGN_WIDTH_PX, 3);
    const min = num(SPACE_MIN_PX[i], 3);
    const max = num(SPACE_MAX_PX[i], 3);
    return decl(`sp-${i}`, `clamp(${min}px, ${preferred}vw, ${max}px)`);
  });

/** The same ramp expressed against the console container's inline size (`cqi`). */
const consoleSpaceRamp = (): string[] =>
  SPACE_PX.map((mid, i) => {
    const override = CONSOLE_CQI_OVERRIDES[i];
    const preferred = override ?? num((mid * 100) / CONSOLE_WIDTH_PX, 2);
    const min = num(SPACE_MIN_PX[i], 3);
    const max = num(SPACE_MAX_PX[i], 3);
    return decl(`sp-${i}`, `clamp(${min}px, ${preferred}cqi, ${max}px)`);
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
    ' * The derived half of the Epo design tokens: the spacing ramp, the type',
    ' * ladder and the control-size ramp, all reproduced from the fitted rules in',
    ' * the scale module. The palette and every other judgement call stays',
    ' * hand-authored in `tokens.palette.css`.',
    ' */',
    '',
    ':root {',
    '  /* ============ TYPE SCALE ============',
    "     One ladder for all static text. Near-duplicate mockup sizes snap to the",
    '     nearest step (8/8.5→2xs · 9/9.5→xs · 10/10.5→sm · 11→md · 11.5/12/12.5→base',
    '     · 13/13.5→lg · 14/14.5/15→xl). SVG clock text (7px caps, 14px readout) stays',
    `     literal where the clock-face geometry depends on it. Linear, not geometric:`,
    `     ${BASE_FONT_PX}px base + [${TYPE_OFFSETS.join(', ')}]. */`,
  ];

  TYPE_NAMES.forEach((name, i) => {
    lines.push(decl(`fs-${name}`, `${num(TYPE_PX[i], 3)}px`, TYPE_NOTES[i]));
  });

  lines.push(
    '',
    '  /* Fluid (container-tracking) type — cqi resolves against the .console',
    "     container. HAND-TUNED per role, not derived: no single container width",
    '     reproduces them (see FLUID_TYPE in design/scale.ts). */',
  );
  for (const role of FLUID_TYPE) {
    lines.push(
      decl(`fs-fluid-${role.name}`, `clamp(${role.min}, ${role.preferred}, ${role.max})`, role.note),
    );
  }

  lines.push(
    '',
    `  /* ============ SPACING (derived — ${BASE_SPACE_PX}px × [${SPACE_STEPS.join(', ')}]) ============`,
    `     ${SPACE_NOTE} */`,
    ...rootSpaceRamp(),
    '',
    `  /* ============ CONTROL SIZES (derived — ${BASE_CONTROL_PX} + ${CONTROL_STEP_PX}n) ============ */`,
  );
  CONTROL_NAMES.forEach((name, i) => {
    lines.push(decl(`h-${name}`, `${CONTROL_PX[i]}px`, CONTROL_NOTES[i]));
  });
  for (const extra of CONTROL_EXTRAS) {
    lines.push(decl(`h-${extra.name}`, `${extra.px}px`, `${extra.note} — off the ramp`));
  }

  lines.push(
    '}',
    '',
    '/* The console — and the stage-hosted Prune page plus each of its card columns —',
    '   is a size container (see shell.css), so the SAME ramp resolves against its',
    `   inline size instead of the viewport: identical px at the ${CONSOLE_WIDTH_PX}px container`,
    '   design width, compressing/expanding with the pane not the page. */',
    '.console,',
    '.prune-page,',
    '.prune-col {',
    ...consoleSpaceRamp(),
    '}',
    '',
  );

  return lines.join('\n');
}
