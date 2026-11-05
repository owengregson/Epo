/**
 * Generator for the derived design tokens (`src/renderer/design/scale.ts`).
 *
 *   node scripts/gen-tokens.mjs           rewrite src/renderer/styles/tokens.generated.css
 *   node scripts/gen-tokens.mjs --check   exit 1 if the committed stylesheet is stale
 *
 * Why a script and not a build step: the stylesheet is COMMITTED, so the app
 * and the test suite need no codegen pass to run, and a reviewer sees the real
 * CSS in the diff. The cost is that it can go stale the moment anyone edits the
 * scale module — `tests/renderer/tokens.test.ts` re-renders in memory and fails
 * the gate when it does.
 *
 * The scale module is TypeScript and this is a plain `.mjs` run by whatever
 * Node the developer has, so it is transpiled with the already-installed
 * esbuild and imported through a `data:` URL. Node's own type-stripping is
 * deliberately not relied on (version-gated, and off for `data:` sources), and
 * nothing is written to a temp file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const SRC = new URL('../src/renderer/design/scale.ts', import.meta.url);
const OUT = new URL('../src/renderer/styles/tokens.generated.css', import.meta.url);
const OUT_LABEL = 'src/renderer/styles/tokens.generated.css';

/** Transpile the scale module and return its `renderTokensCss()` output. */
export async function renderTokens() {
  const source = readFileSync(SRC, 'utf8');
  const { code } = transformSync(source, { loader: 'ts', format: 'esm' });
  const module = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  return module.renderTokensCss();
}

/** The first line that differs, as `line N: - old / + new` — enough to see the drift. */
function firstDifference(current, fresh) {
  const a = current.split('\n');
  const b = fresh.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return [`line ${i + 1}:`, `  - ${a[i] ?? '<end of file>'}`, `  + ${b[i] ?? '<end of file>'}`].join('\n');
    }
  }
  return '  (files differ only in trailing bytes)';
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  const css = await renderTokens();
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== css) {
      console.error(`${OUT_LABEL} is stale — run \`node scripts/gen-tokens.mjs\`.`);
      console.error(firstDifference(current, css));
      process.exit(1);
    }
    console.log(`${OUT_LABEL} is up to date.`);
  } else {
    writeFileSync(OUT, css);
    console.log(`Wrote ${OUT_LABEL} (${css.length} bytes).`);
  }
}
