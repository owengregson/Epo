/**
 * Ensure the local Electron dev binary is present, de-quarantined, and ad-hoc
 * codesigned so macOS Gatekeeper/XProtect does not block or trash it on launch.
 *
 * Why this exists: on recent macOS (26.x), launching the unsigned, npm-downloaded
 * Electron runtime can trip XProtect Remediator, which quarantines or MOVES THE
 * BINARY TO TRASH ("malware"). Ad-hoc signing + clearing the com.apple.quarantine
 * xattr lets the local dev build run. This is a dev-only convenience — it does not
 * ship in any packaged app.
 *
 * No-op on non-macOS. Best-effort: warns but never hard-fails the launch chain,
 * except when the binary is missing AND cannot be reinstalled.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';

if (process.platform !== 'darwin') {
  process.exit(0);
}

const APP = 'node_modules/electron/dist/Electron.app';
const INSTALL_JS = 'node_modules/electron/install.js';

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

// 1. If a previous XProtect sweep trashed the binary (or it was never extracted),
//    re-run Electron's own installer to restore dist/Electron.app.
if (!existsSync(APP)) {
  if (!existsSync(INSTALL_JS)) {
    console.error('[fix-electron-macos] electron package missing — run `npm install` first.');
    process.exit(1);
  }
  console.log('[fix-electron-macos] Electron.app missing; running electron installer…');
  try {
    run(process.execPath, [INSTALL_JS]);
  } catch (e) {
    console.error('[fix-electron-macos] electron installer failed:', e.message);
    process.exit(1);
  }
}

if (!existsSync(APP)) {
  console.error('[fix-electron-macos] Electron.app still missing after install — cannot continue.');
  process.exit(1);
}

// 2. Clear the quarantine xattr (Gatekeeper block on first launch).
try {
  run('xattr', ['-cr', APP]);
} catch (e) {
  console.warn('[fix-electron-macos] xattr clear failed (continuing):', e.message);
}

// 3. Brand the dev bundle: unpackaged runs surface the bundle's Info.plist name
//    and icns in the Dock, so patch them to Epo's. Must happen BEFORE the
//    codesign step below — editing the bundle afterward would invalidate the
//    fresh signature. Idempotent: plutil rewrites the same values every run.
const PLIST = `${APP}/Contents/Info.plist`;
const ICNS = 'build/icon.icns';
try {
  run('plutil', ['-replace', 'CFBundleName', '-string', 'Epo', PLIST]);
  run('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Epo', PLIST]);
  if (existsSync(ICNS)) {
    copyFileSync(ICNS, `${APP}/Contents/Resources/electron.icns`);
  }
  // Bump the bundle's mtime so LaunchServices/Dock drop their cached icon.
  run('touch', [APP]);
  console.log('[fix-electron-macos] dev bundle branded as Epo (name + icon).');
} catch (e) {
  console.warn('[fix-electron-macos] dev branding failed (continuing):', e.message);
}

// 4. Ad-hoc deep-sign so the runtime + nested helpers/frameworks are trusted locally.
try {
  run('codesign', ['--force', '--deep', '--sign', '-', APP]);
  console.log('[fix-electron-macos] Electron.app de-quarantined and ad-hoc signed.');
} catch (e) {
  console.warn('[fix-electron-macos] codesign failed (launch may be blocked):', e.message);
}
