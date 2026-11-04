/** Verify-only startup: record the initial tool load and retain partial evidence even if readiness fails. */
import { app, type WebContents, type WebContentsView } from 'electron';
import { awaitLogin, ensureInstagramOrigin, openToolWindow } from '@/main/bootstrap';
import { verifyProbe } from '@/probe/verify';
import { VerifyEvidence } from '@/probe/verify-evidence';
import { HARNESS } from '@/timing/config';
import { sleep } from '@/timing/primitives';

export async function launchVerify(out: string, target: string): Promise<void> {
  const evidence = new VerifyEvidence(out);
  const created = (_event: unknown, contents: WebContents) => evidence.record(contents);
  app.once('web-contents-created', created);
  try {
    if (target === '') { evidence.stop('target-required'); evidence.assert(); }
    const tool = openToolWindow({ title: 'Epo — live probe (verify)' });
    const ready = tool.ready.catch((error: unknown) => evidence.stop('initial-navigation', String(error)));
    app.removeListener('web-contents-created', created);
    const view = tool.win.contentView.children[0] as WebContentsView | undefined;
    evidence.requireRecorder(view?.webContents);
    evidence.observe(tool.tab);
    await evidence.wait(ready);
    await evidence.check(tool.tab);
    const loggedIn = await evidence.wait(awaitLogin(() => tool.isOpen() && !evidence.abort.signal.aborted));
    if (!loggedIn) { evidence.stop('login-unavailable'); evidence.assert(); }
    await evidence.wait(ensureInstagramOrigin(tool.tab));
    // Preserve the tool's existing four-second initial hydration pause, now interruptible on a wall.
    await evidence.wait(sleep(HARNESS.CAPTURE_NAV_SETTLE_MS, evidence.abort.signal));
    await verifyProbe(tool.tab, evidence, target);
  } catch (error) {
    evidence.stop('exception', String(error));
  } finally {
    app.removeListener('web-contents-created', created);
    await evidence.finish();
  }
  evidence.assert();
}
