/**
 * The branded dev executable can report app.isPackaged. Electron's defaultApp flag still identifies a
 * script passed to its runtime, including scripts launched by run-desktop.mjs; those are not installed builds.
 */
export function isInstalledApp(isPackaged: boolean, defaultApp: boolean | undefined): boolean {
  return isPackaged && defaultApp !== true;
}
