/**
 * Derives the bundler's engine targets from the Electron binary this repo has
 * actually installed — not from a literal a human remembered to update.
 *
 *   node scripts/gen-targets.mjs            write build/targets.generated.json
 *   node scripts/gen-targets.mjs --check    exit 1 if the committed file is stale
 *
 * Electron is the ONLY runtime Epo's bundles ever execute in: the four Node
 * bundles run in its main process (`process.versions.node`) and the renderer
 * runs in its Chromium (`process.versions.chrome`). Asking the binary itself
 * removes the failure mode ADR-1001 exists for — a stale `chrome150` literal
 * compiles fine and ships subtly-wrong output after an Electron major.
 *
 * The probe is `ELECTRON_RUN_AS_NODE=1 electron -p …`, which starts Electron as
 * a plain Node process (no window, no GPU) and prints its own version table.
 *
 * Degraded check: with `npm ci --ignore-scripts` the binary is never downloaded,
 * so `--check` falls back to comparing the recorded `electronVersion` against
 * `node_modules/electron/package.json`. That still catches the drift that
 * matters (a dependabot Electron bump landing on stale targets); it cannot
 * catch a hand-edited `chrome`/`node` field, and it says so.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT_URL = new URL('../build/targets.generated.json', import.meta.url);
const ELECTRON_DIR = new URL('../node_modules/electron/', import.meta.url);

export const OUT_PATH = fileURLToPath(OUT_URL);

/** The `electron` package's own version — readable without the binary. */
export function installedElectronVersion() {
  const pkg = new URL('package.json', ELECTRON_DIR);
  if (!existsSync(pkg)) return null;
  return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
}

/** Absolute path to the Electron executable, or null when it was never downloaded. */
function electronBinary() {
  const pathTxt = new URL('path.txt', ELECTRON_DIR);
  if (!existsSync(pathTxt)) return null;
  const relative = readFileSync(pathTxt, 'utf8').trim();
  const binary = new URL(`dist/${relative}`, ELECTRON_DIR);
  return existsSync(binary) ? fileURLToPath(binary) : null;
}

/**
 * `process.versions` as reported by the installed Electron, or null when the
 * binary is absent (CI installs with `--ignore-scripts`).
 */
export function probeElectron() {
  const binary = electronBinary();
  if (!binary) return null;
  const result = spawnSync(binary, ['-p', 'JSON.stringify(process.versions)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  // Electron can print startup noise before the value; the table is the last
  // line that parses as JSON.
  for (const line of result.stdout.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed && typeof parsed.node === 'string') return parsed;
    } catch {
      // Not the value line — keep walking back.
    }
  }
  return null;
}

/** The committed artifact's shape. Majors only: esbuild targets are per-major. */
export function renderTargets(versions) {
  const major = (v) => String(v).split('.')[0];
  return {
    node: `node${major(versions.node)}`,
    chrome: `chrome${major(versions.chrome)}`,
    electronVersion: versions.electron,
    nodeVersion: versions.node,
    chromeVersion: versions.chrome,
  };
}

/** The committed artifact, or null when it has never been generated. */
export function readTargets() {
  if (!existsSync(OUT_URL)) return null;
  return JSON.parse(readFileSync(OUT_URL, 'utf8'));
}

const serialize = (targets) => `${JSON.stringify(targets, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const versions = probeElectron();
  const current = readTargets();

  if (check) {
    if (!current) {
      console.error(`${OUT_PATH} is missing — run \`npm run gen:targets\`.`);
      process.exit(1);
    }
    if (versions) {
      const fresh = renderTargets(versions);
      if (serialize(current) !== serialize(fresh)) {
        console.error(
          `${OUT_PATH} is stale.\n  committed: ${JSON.stringify(current)}\n  installed: ${JSON.stringify(fresh)}\nRun \`npm run gen:targets\`.`,
        );
        process.exit(1);
      }
      console.log(`targets.generated.json matches Electron ${fresh.electronVersion}.`);
    } else {
      const installed = installedElectronVersion();
      if (installed && current.electronVersion !== installed) {
        console.error(
          `${OUT_PATH} records Electron ${current.electronVersion} but ${installed} is installed — run \`npm run gen:targets\`.`,
        );
        process.exit(1);
      }
      console.log(
        `Electron binary not downloaded; checked electronVersion only (${current.electronVersion}).`,
      );
    }
  } else {
    if (!versions) {
      console.error(
        'Cannot probe Electron: the binary is not installed. Run `npm install` without --ignore-scripts (or `node node_modules/electron/install.js`).',
      );
      process.exit(1);
    }
    const targets = renderTargets(versions);
    writeFileSync(OUT_URL, serialize(targets));
    console.log(`Wrote ${OUT_PATH} — ${targets.node}, ${targets.chrome} (electron ${targets.electronVersion}).`);
  }
}
