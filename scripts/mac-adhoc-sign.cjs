/**
 * electron-builder afterPack hook — ad-hoc sign the macOS app.
 *
 * With `identity: null` electron-builder skips signing entirely, and its
 * packaging (asar, plists, unpacked native modules) invalidates the ad-hoc
 * signature Electron's binaries ship with. On Apple Silicon an app with an
 * INVALID signature gets Gatekeeper's dead-end "Epo is damaged and can't be
 * opened" dialog — no Open Anyway, terminal-only rescue. A fresh ad-hoc
 * signature (`codesign --sign -`) restores the normal unidentified-developer
 * flow: open once, then System Settings → Privacy & Security → Open Anyway.
 *
 * This is NOT Developer-ID signing or notarization (a later, paid step) —
 * it only keeps the unsigned builds openable.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Real Developer ID signing configured (CSC_LINK) — electron-builder signs
  // after this hook and would overwrite an ad-hoc signature anyway; skip.
  if (process.env.CSC_LINK) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appPath}`);
};
