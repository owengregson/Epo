/**
 * Entry for the nightly `readme-live` workflow: renders the four live-panel
 * SVGs (growth + pace, light + dark) into the directory given as argv[2]
 * (default `out/readme-live/charts`). Bundle and run:
 *
 *   npx esbuild src/readme/render-live-charts.ts --bundle --platform=node \
 *     --outfile=dist/readme/render-live-charts.cjs
 *   node dist/readme/render-live-charts.cjs out/readme-live/charts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { growthCharts, paceCharts, planOneDay } from './live-charts';

const outDir = process.argv[2] ?? path.join('out', 'readme-live', 'charts');
mkdirSync(outDir, { recursive: true });

const now = new Date();
const pad = (n: number): string => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const dayOfYear = Math.floor((dayStart - new Date(now.getFullYear(), 0, 1).getTime()) / 86_400_000);
const seed = now.getFullYear() * 10_000 + (now.getMonth() + 1) * 100 + now.getDate();

const growth = growthCharts(dayOfYear, stamp);
const pace = paceCharts(planOneDay(dayStart, seed), stamp);

const files: Record<string, string> = {
  'growth.svg': growth.light,
  'growth-dark.svg': growth.dark,
  'pace.svg': pace.light,
  'pace-dark.svg': pace.dark,
};
for (const [name, svg] of Object.entries(files)) {
  writeFileSync(path.join(outDir, name), svg);
  console.log(`wrote ${path.join(outDir, name)}`);
}
