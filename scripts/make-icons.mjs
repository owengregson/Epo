/**
 * Regenerate the app icons from the canonical art:
 *
 *   project/assets/epo_appicon.png  (1024x1024 full-bleed, the single source
 *                                    of truth)
 *     -> build/icon.png      macOS presentation: artwork scaled to 824px and
 *                            centered on a transparent 1024 canvas (Apple's
 *                            icon grid; full-bleed renders oversized next to
 *                            every other Dock icon). Also what the dev Dock
 *                            icon uses (main.ts setDevDockIcon).
 *     -> build/icon.icns     macOS icon, derived from the padded png via
 *                            sips + iconutil.
 *     -> build/icon-win.png  Windows presentation: full-bleed copy (Windows
 *                            icons carry no Apple margin); electron-builder
 *                            derives the .ico from it (win.icon).
 *
 * Run from the repo root after replacing the canonical png:
 *   node scripts/make-icons.mjs
 *
 * macOS-only (needs sips + iconutil, plus ffmpeg for the transparent pad).
 * Dev runs pick the new icns up on the next launch via
 * scripts/fix-electron-macos.mjs; packaged builds on the next `npm run dist`.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const SRC = 'project/assets/epo_appicon.png';
const OUT_PNG = 'build/icon.png';
const OUT_ICNS = 'build/icon.icns';
const OUT_WIN = 'build/icon-win.png';

// Apple's macOS icon grid: a 1024 canvas with the artwork at 824, margins 100.
const CANVAS = 1024;
const ART = 824;
const MARGIN = (CANVAS - ART) / 2;

if (process.platform !== 'darwin') {
  console.error('[make-icons] macOS-only (needs sips + iconutil).');
  process.exit(1);
}

copyFileSync(SRC, OUT_WIN);

try {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', SRC,
      '-vf',
      `scale=${ART}:${ART}:flags=lanczos,format=rgba,pad=${CANVAS}:${CANVAS}:${MARGIN}:${MARGIN}:color=#00000000`,
      OUT_PNG,
    ],
    { stdio: 'inherit' },
  );
} catch {
  console.error('[make-icons] ffmpeg is required for the transparent pad (brew install ffmpeg).');
  process.exit(1);
}

// Standard iconset from the padded canvas: each point size, 1x and @2x.
const tmp = mkdtempSync(path.join(tmpdir(), 'epo-icons-'));
const iconset = path.join(tmp, 'icon.iconset');
mkdirSync(iconset);
for (const pt of [16, 32, 128, 256, 512]) {
  for (const [suffix, px] of [['', pt], ['@2x', pt * 2]]) {
    execFileSync(
      'sips',
      ['-z', String(px), String(px), OUT_PNG, '--out', path.join(iconset, `icon_${pt}x${pt}${suffix}.png`)],
      { stdio: 'ignore' },
    );
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', OUT_ICNS]);
rmSync(tmp, { recursive: true, force: true });

console.log(`[make-icons] regenerated ${OUT_PNG}, ${OUT_ICNS}, ${OUT_WIN} from ${SRC}`);
