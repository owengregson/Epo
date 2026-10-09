/**
 * Bundler for the in-page scripts (`src/adapter/page/*.ts`).
 *
 *   node esbuild.page.mjs           rebuild src/adapter/page/bundle.generated.ts
 *   node esbuild.page.mjs --check   exit 1 if the committed bundle is stale
 *
 * Why a second, standalone build: the page modules run INSIDE the Instagram
 * tab, so they cannot be `import`ed at runtime — the Actor can only hand
 * `webContents.executeJavaScript` a STRING. Bundling them into one IIFE that
 * defines a local `__epoPage` gives the version modules a string to prefix each
 * call with, while the sources themselves stay type-checked (`tsc`), linted
 * (`biome`), and DOM-tested (`tests/page/**`) like any other code.
 *
 * The result is COMMITTED (`bundle.generated.ts`) so no build step is needed to
 * run the app or the tests; `tests/page/bundle-fresh.test.ts` rebuilds in memory
 * and fails the gate when the committed copy drifts from the sources.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const ENTRY = 'src/adapter/page/index.ts';
const OUT = 'src/adapter/page/bundle.generated.ts';
const GLOBAL = '__epoPage';

/** Bundle page modules for a caller's function scope, without writing to window. */
export async function buildPageBundle() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: GLOBAL,
    // Electron 43 ships Chromium 150 — the only engine this code ever runs in.
    target: 'chrome150',
    platform: 'browser',
    minify: true,
    legalComments: 'none',
  });
  return result.outputFiles[0].text.trim();
}

/** The `.ts` module wrapping the bundle as an exported string constant. */
export function renderModule(bundle) {
  return `/**
 * GENERATED — do not edit. Run \`node esbuild.page.mjs\` after changing anything
 * under \`src/adapter/page/\`; \`tests/page/bundle-fresh.test.ts\` fails the gate
 * when this file drifts from the sources.
 *
 * The bundled in-page scripts. Embed inside a function scope using pageCall;
 * the local \`__epoPage\` variable must never become a property of the page.
 */

export const PAGE_BUNDLE = ${JSON.stringify(bundle)};
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const module = renderModule(await buildPageBundle());
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== module) {
      console.error(`${OUT} is stale — run \`node esbuild.page.mjs\`.`);
      process.exit(1);
    }
    console.log(`${OUT} is up to date.`);
  } else {
    writeFileSync(OUT, module);
    console.log(`Wrote ${OUT} (${module.length} bytes).`);
  }
}
