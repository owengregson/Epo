import { build } from 'esbuild';
import { existsSync, mkdirSync, cpSync } from 'fs';

const isDev = process.argv.includes('--dev');
if (!existsSync('dist')) mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  bundle: true, platform: 'node', target: 'node18', outdir: 'dist/main',
  external: ['electron', 'better-sqlite3'],
  sourcemap: isDev, minify: !isDev, format: 'cjs',
});

await build({
  entryPoints: ['src/capture/capture-main.ts'],
  bundle: true, platform: 'node', target: 'node18', outdir: 'dist/capture',
  external: ['electron', 'better-sqlite3'],
  sourcemap: isDev, minify: !isDev, format: 'cjs',
});

await build({
  entryPoints: ['src/livetest/livetest-main.ts'],
  bundle: true, platform: 'node', target: 'node18', outdir: 'dist/livetest',
  external: ['electron', 'better-sqlite3'],
  sourcemap: isDev, minify: !isDev, format: 'cjs',
});

await build({
  entryPoints: ['src/inspect/inspect-main.ts'],
  bundle: true, platform: 'node', target: 'node18', outdir: 'dist/inspect',
  external: ['electron', 'better-sqlite3'],
  sourcemap: isDev, minify: !isDev, format: 'cjs',
});

// Renderer (dashboard console). The entry imports `styles/index.css`, so esbuild
// bundles the CSS graph — including self-hosted FontAwesome — into a sibling
// `index.css`, and embeds the webfont files as `data:` URIs (offline + CSP-safe
// under `font-src 'self' data:`). No CDN, no separate font requests.
await build({
  entryPoints: ['src/renderer/index.tsx'],
  bundle: true, platform: 'browser', target: 'chrome120', outdir: 'dist/renderer',
  sourcemap: isDev, minify: !isDev, format: 'iife',
  jsxFactory: 'h', jsxFragment: 'Fragment',
  loader: {
    '.tsx': 'tsx',
    '.ts': 'ts',
    '.woff2': 'dataurl',
    '.woff': 'dataurl',
    '.ttf': 'dataurl',
  },
});

if (existsSync('src/renderer/index.html')) cpSync('src/renderer/index.html', 'dist/renderer/index.html');
// Static overlay page (the automation veil) served by the main process.
if (existsSync('src/main/overlay')) cpSync('src/main/overlay', 'dist/main/overlay', { recursive: true });
console.log('Build complete.');
