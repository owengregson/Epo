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

/** One custom-property declaration, with an optional trailing role comment. */
const decl = (name: string, value: string, note?: string): string =>
  `  --${name}: ${value};${note === undefined ? '' : ` /* ${note} */`}`;

/** Stable spacing: nested panes share the same rhythm; responsive layouts change their columns. */
const spaceRamp = (): string[] => SPACE_PX.map((px, i) => decl(`sp-${i}`, `${px}px`));

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
    '     Stable across panes and nested cards; responsiveness belongs to layout. */',
    ...spaceRamp(),
    '',
    `  /* ============ CONTROL SIZES (derived — ${BASE_CONTROL_PX} + ${CONTROL_STEP_PX}n) ============ */`,
  );
  CONTROL_NAMES.forEach((name, i) => {
    lines.push(decl(`h-${name}`, `${CONTROL_PX[i]}px`, CONTROL_NOTES[i]));
  });

  lines.push('}', '');

  return lines.join('\n');
}
