# 0404 — Icons are inline SVG paths, not a bundled webfont

Status: accepted (2026-09-02)

## Context

`dist/renderer/index.css` was 488,984 bytes. 313 KB of that — about 69% — was
base64 webfont data: the whole of FontAwesome 7 (three CSS files plus four
`.woff2`/`.woff`/`.ttf` faces), imported for 48 glyphs. One brand mark
(`instagram`, in the stage bar) dragged in the entire 115 KB brands face. The
esbuild `.woff2`/`.woff`/`.ttf` dataurl loaders and two lines of `assets.d.ts`
existed only to serve it. Every renderer build shipped and parsed 400 KB nobody
reads.

## Decision

`ui/icons.ts` holds a path map: name → `{ box, d }`, copied from
`@fortawesome/fontawesome-free/svgs/<family>/<name>.svg`. `ui/Icon.tsx` renders
one `<svg viewBox=… width="1em" height="1em" fill="currentColor">` with that
path. `Icon`'s public API — `name` / `brand` / `spin` / `title` — is unchanged,
so no call site moved.

The glyphs remain FontAwesome Free, licensed CC BY 4.0; the attribution lives in
`icons.ts`'s header comment. `lucide-static` (ISC, no attribution) was the
alternative and was not taken: its shapes differ slightly from the ones the
design was drawn against, and the Instagram mark would have had to come from a
separate source anyway.

The three `@import`s in `styles/index.css` are gone, `assets.d.ts` keeps only
`declare module '*.css'` (TS7's TS2882 requires it for the entry's stylesheet
import), and `fa-spin` became a four-line `@keyframes icon-spin` in `base.css`.
The ~20 CSS rules that sized icons by descendant selector (`.card-h .fa-solid`)
now say `.card-h .icon`; sizing still works through `font-size` because the SVG
is `1em` square.

## Consequences

- `dist/renderer/index.css`: **488,984 → 65,909 bytes (−86.5%)**, dev build.
- The `@fortawesome/fontawesome-free` runtime dependency and the three font
  loaders in `esbuild.config.mjs` are now unreferenced and can be removed
  (handed to the tooling pass — those files are not the renderer's to edit).
- Adding a glyph is one entry in `icons.ts`. An unknown name renders an empty
  box rather than throwing, so a typo cannot blank a card; a render test pins
  the names the app actually uses.
- Icons inherit `currentColor` and the host's `font-size`, exactly as the font
  glyphs did — no call site or colour rule changed.
