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
  entryPoints: ['src/renderer/index.tsx'],
  bundle: true, platform: 'browser', target: 'chrome120', outdir: 'dist/renderer',
  sourcemap: isDev, minify: !isDev, format: 'iife',
  jsxFactory: 'h', jsxFragment: 'Fragment',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
});

if (existsSync('src/renderer/index.html')) cpSync('src/renderer/index.html', 'dist/renderer/index.html');
if (existsSync('src/renderer/styles')) cpSync('src/renderer/styles', 'dist/renderer/styles', { recursive: true });
console.log('Build complete.');
