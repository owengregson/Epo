import { TIMED_OUT, withTimeout } from '@/timing/primitives';

interface StartupFailureDeps {
  /** False when intentional shutdown or another failure already owns exit. */
  claim(): boolean;
  block(error: unknown): void;
  dispose(): Promise<void>;
  closeLog(): Promise<void>;
  report(phase: string, error: unknown): void;
  exit(code: number): void;
}

/** A failed startup must exit abnormally for the launcher, but must never
 * authorize account activity when it restarts. Logging and cleanup are bounded. */
export async function terminateFailedStartup(error: unknown, deps: StartupFailureDeps): Promise<void> {
  if (!deps.claim()) return;
  deps.report('startup failed', error);
  try { deps.block(error); }
  catch (failure) { deps.report('startup block persistence failed', failure); }
  const settle = async (phase: string, run: () => Promise<void>, ms: number): Promise<void> => {
    try {
      if (await withTimeout(Promise.resolve().then(run), ms) === TIMED_OUT) deps.report(phase, 'deadline exceeded');
    } catch (failure) { deps.report(phase, failure); }
  };
  await settle('startup cleanup failed', () => deps.dispose(), 15_000);
  await settle('startup log drain failed', () => deps.closeLog(), 2_000);
  deps.exit(1);
}
