# 0301 — In-page scripts are TypeScript, not template literals

**Status:** accepted · **Area:** adapter (`src/adapter/page/**`, `esbuild.page.mjs`,
`src/adapter/versions/*`)

## Context

The Actor drives Instagram's DOM by handing `webContents.executeJavaScript` a
string. Every one of those strings used to be a template literal inside the
version module: 504 of that file's 1,451 lines were in-page JavaScript.

Nothing checked them. `tsc` sees a string. Biome sees a string. No test ever ran
one against a DOM — the only "test" of a page script was a `toContain('header
button')` grep. A typo shipped and surfaced in production as an
`AdapterStaleError` at 3am, indistinguishable from real selector drift.

Worse, the strings duplicated each other: the four-regex button search existed
three times, and eight click/locate twins shared 132 identical lines. A selector
fix had to be applied two or three times by hand, and a partial fix let the
locate and click paths disagree silently.

## Decision

The in-page logic is real TypeScript under `src/adapter/page/`, bundled by a
standalone `esbuild.page.mjs` into one IIFE that defines `window.__epoPage`.
A version module builds each script as:

```
`${PAGE_BUNDLE};__epoPage.<fn>(${JSON.stringify(cfg)})`
```

Two rules keep the layering intact:

1. **`src/adapter/page/*` carries ZERO Instagram literals.** Every selector,
   regex, text matcher, and scope list arrives as a JSON config parameter. This
   strengthens the existing constraint rather than weakening it: the literals
   still live only in `src/adapter/versions/*`, and a new capture now supplies
   ~120 lines of tables instead of re-implementing 500 lines of DOM mechanics.
   `tests/page/bundle-fresh.test.ts` asserts the bundle contains none of the
   surface's selectors, its origin, or its app id.
2. **The bundle is generated, committed, and freshness-tested.** Committing it
   means the app and the test suite need no build step; the freshness test
   rebuilds in memory (`node esbuild.page.mjs --check`) and fails the gate when
   the committed copy drifts from the sources — a stale bundle would ship OLD
   mechanics while every unit test exercised the new ones.

## Consequences

- The page mechanics are type-checked, linted, and tested against a DOM
  (`tests/page/**`, jsdom) for the first time. The hidden-twin confirm menu, the
  icon-alt-text button suffix, the `<a href="#">` followers stat, and the
  largest-scrollable heuristic all have real regression tests.
- Every script now carries the ~6.5 KB bundle prefix. Measured against the cost
  it replaces (three copies of the same search, none of them verifiable) this is
  cheap; `executeJavaScript` is not the bottleneck on any of these paths.
- Test fakes identify a script by its trailing call (`__epoPage.<fn>({`) instead
  of a marker comment. `tests/kit/tabs.ts` exposes `pageCall(fn, ...cfgParts)`.
- Editing anything under `src/adapter/page/` requires re-running
  `node esbuild.page.mjs`. The gate says so when you forget.

## Alternatives rejected

- **Keep the template literals, add a linter.** No linter reads a string
  literal as JavaScript, and the duplication would remain.
- **Ship the page modules as separate files and load them at runtime.** The tab
  can only be handed a string; a loader would be more machinery for the same
  result.
- **Generate at build time instead of committing.** Every test run and every
  `npm start` would need a build step, and a developer running `npx jest`
  against a stale `dist/` would silently test something else.
