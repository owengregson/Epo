/**
 * Bundler for every Epo entry point.
 *
 *   node esbuild.config.mjs                  production bundles (minified)
 *   node esbuild.config.mjs --dev            sourcemaps, no minify, dist/meta-*.json
 *   node esbuild.config.mjs --dev --watch    rebuild on change; never exits
 *
 * Seven bundles: six Node ones (main+preload, capture, livetest, inspect, probe,
 * surface-lab) that share a single option set, and the renderer, which differs
 * in platform and JSX. Only `electron` stays external; the store runs on the
 * runtime's built-in `node:sqlite`, so nothing native ships.
 */
import { context, build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const isDev = process.argv.includes('--dev');
const isWatch = process.argv.includes('--watch');

if (!existsSync('dist')) mkdirSync('dist', { recursive: true });

// Engine targets are DERIVED from the installed Electron binary
// (`scripts/gen-targets.mjs` → `build/targets.generated.json`, ADR 1001), not
// typed here. The literals below are the last-known-good fallback for a tree
// where the artifact has not been generated yet; the build says so loudly and
// `npm run gen:targets:check` fails the gate.
const FALLBACK_TARGETS = { node: 'node24', chrome: 'chrome152' };
const TARGETS_FILE = new URL('./build/targets.generated.json', import.meta.url);

const readTargets = () => {
  const fallback = (why) => {
    console.warn(
      `[esbuild] ${why} — falling back to ${FALLBACK_TARGETS.node}/${FALLBACK_TARGETS.chrome}. Run \`npm run gen:targets\`.`,
    );
    return FALLBACK_TARGETS;
  };
  if (!existsSync(TARGETS_FILE)) return fallback('build/targets.generated.json is missing');
  try {
    const parsed = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
    const valid = /^node\d+$/.test(parsed.node ?? '') && /^chrome\d+$/.test(parsed.chrome ?? '');
    if (!valid) return fallback('build/targets.generated.json has no usable node/chrome target');
    return { node: parsed.node, chrome: parsed.chrome };
  } catch (error) {
    return fallback(`build/targets.generated.json is unreadable (${error.message})`);
  }
};

const TARGETS = readTargets();

/** Options every bundle shares; `--dev` swaps minification for debuggability. */
const shared = {
  bundle: true,
  sourcemap: isDev,
  minify: !isDev,
  // A dev-only build manifest: `dist/meta-<name>.json` feeds esbuild's bundle
  // analyzer when something unexpected lands in a bundle.
  metafile: isDev,
};

/** The four Electron-main-side bundles differ only in entry point and outdir. */
const nodeOptions = {
  platform: 'node',
  target: TARGETS.node,
  format: 'cjs',
  external: ['electron'],
};

const jobs = [];
/** Queue one bundle. `name` labels its dev metafile. */
const bundle = (name, entryPoints, outdir, options) =>
  jobs.push({ name, options: { ...shared, ...options, entryPoints, outdir } });

bundle('main', ['src/main/main.ts', 'src/main/preload.ts'], 'dist/main', nodeOptions);
bundle('capture', ['src/capture/capture-main.ts'], 'dist/capture', nodeOptions);
bundle('livetest', ['src/livetest/livetest-main.ts'], 'dist/livetest', nodeOptions);
bundle('inspect', ['src/inspect/inspect-main.ts'], 'dist/inspect', nodeOptions);
bundle('probe', ['src/probe/probe-main.ts'], 'dist/probe', nodeOptions);
bundle('surface-lab', ['src/surface-lab/main.ts'], 'dist/surface-lab', nodeOptions);

// Renderer (dashboard console). The entry imports `styles/index.css`, so esbuild
// bundles the CSS graph into a sibling `index.css`. Icons are inline SVG paths
// (`ui/icons.ts`), so no webfont is bundled — no CDN, no font requests, CSP-safe.
// `target` is the Chromium the installed Electron ships — the only browser this
// bundle ever runs in — read from `build/targets.generated.json`.
bundle('renderer', ['src/renderer/index.tsx'], 'dist/renderer', {
  platform: 'browser',
  target: TARGETS.chrome,
  format: 'iife',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
});

/** Files copied verbatim, not bundled: the renderer shell and the overlay page. */
const copyStatics = () => {
  if (existsSync('src/renderer/index.html')) {
    cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  }
  if (existsSync('src/main/overlay')) {
    cpSync('src/main/overlay', 'dist/main/overlay', { recursive: true });
  }
};

if (isWatch) {
  // Watch mode holds a context per bundle and never resolves, so the process
  // stays alive until it is killed. Statics are copied once up front — they are
  // plain files, not part of any bundle's dependency graph.
  await Promise.all(jobs.map(async ({ options }) => (await context(options)).watch()));
  copyStatics();
  console.log('Watching for changes… (ctrl-c to stop)');
} else {
  for (const { name, options } of jobs) {
    const result = await build(options);
    if (result.metafile) {
      writeFileSync(`dist/meta-${name}.json`, JSON.stringify(result.metafile));
    }
  }
  copyStatics();
  console.log('Build complete.');
}
