/**
 * CI-ONLY: nothing here ships. `.github/workflows/readme-live.yml` bundles it nightly; it lives under
 * `src/` because it imports the REAL day plan, which is what makes the published chart honest. Renders
 * the pace panel's two SVGs (light + dark) into argv[2] (default `out/readme-live/charts`):
 *
 *   npx esbuild src/tools/readme/render-live-charts.ts --bundle --platform=node \
 *     --outfile=dist/readme/render-live-charts.cjs
 *   node dist/readme/render-live-charts.cjs out/readme-live/charts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { paceCharts, planOneDay } from './live-charts';

const outDir = process.argv[2] ?? path.join('out', 'readme-live', 'charts');
mkdirSync(outDir, { recursive: true });

const now = new Date();
const pad = (n: number): string => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const seed = now.getFullYear() * 10_000 + (now.getMonth() + 1) * 100 + now.getDate();

const pace = paceCharts(planOneDay(dayStart, seed), stamp);

const files: Record<string, string> = {
  'pace.svg': pace.light,
  'pace-dark.svg': pace.dark,
};
for (const [name, svg] of Object.entries(files)) {
  writeFileSync(path.join(outDir, name), svg);
  console.log(`wrote ${path.join(outDir, name)}`);
}
