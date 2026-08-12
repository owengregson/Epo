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
import { existsSync } from 'node:fs';

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

// 3. Ad-hoc deep-sign so the runtime + nested helpers/frameworks are trusted locally.
try {
  run('codesign', ['--force', '--deep', '--sign', '-', APP]);
  console.log('[fix-electron-macos] Electron.app de-quarantined and ad-hoc signed.');
} catch (e) {
  console.warn('[fix-electron-macos] codesign failed (launch may be blocked):', e.message);
}
