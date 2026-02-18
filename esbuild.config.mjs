import { build } from 'esbuild';
import { existsSync, mkdirSync, cpSync } from 'fs';
import path from 'path';

const isDev = process.argv.includes('--dev');

// Ensure dist directory exists
if (!existsSync('dist')) mkdirSync('dist', { recursive: true });

// Main process
await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: 'dist/main',
  external: ['electron', 'puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
  sourcemap: isDev,
  minify: !isDev,
  format: 'cjs',
});

// Renderer process
await build({
  entryPoints: ['src/renderer/index.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  outdir: 'dist/renderer',
  sourcemap: isDev,
  minify: !isDev,
  format: 'iife',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
});

// Copy static assets
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles', 'dist/renderer/styles', { recursive: true });

// Copy FontAwesome assets
if (existsSync('node_modules/@fortawesome/fontawesome-free')) {
  if (!existsSync('dist/renderer/vendor/fontawesome/css')) {
    mkdirSync('dist/renderer/vendor/fontawesome/css', { recursive: true });
  }
  cpSync(
    'node_modules/@fortawesome/fontawesome-free/css/all.min.css',
    'dist/renderer/vendor/fontawesome/css/all.min.css'
  );
  cpSync(
    'node_modules/@fortawesome/fontawesome-free/webfonts',
    'dist/renderer/vendor/fontawesome/webfonts',
    { recursive: true }
  );
}

console.log('Build complete.');
