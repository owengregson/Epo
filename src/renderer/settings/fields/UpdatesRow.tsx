/**
 * Updates (spec §13): the updater's honest state — not checked yet, couldn't check, or up to date with the
 * time of the check. "Up to date" never shows without a finished check behind it. One action per state:
 * check, restart into a downloaded update (confirmed), or open the download page.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useNow } from '@/renderer/app/clock';
import type { UpdateStatus } from '@/shared/update-status';
import { UPDATES_COPY } from '../copy/fields';
import { agoLabel, fill } from '../format';
import type { StageApi } from '../stage-api';

export function updateLine(u: UpdateStatus | null, now: number): string {
  if (u === null) return UPDATES_COPY.waiting;
  if (u.mode === 'off') return UPDATES_COPY.off;
  const v = u.version ?? '';
  switch (u.state) {
    case 'checking': return UPDATES_COPY.checking;
    case 'available': return fill(u.mode === 'full' ? UPDATES_COPY.availableFull : UPDATES_COPY.availableNotify, { v });
    case 'downloading': return fill(UPDATES_COPY.downloading, { v, p: u.percent ?? 0 });
    case 'ready': return fill(UPDATES_COPY.ready, { v });
    case 'error': return u.error === null ? UPDATES_COPY.error : `${UPDATES_COPY.error} ${u.error}`;
    case 'unavailable': return UPDATES_COPY.unavailable;
    case 'unchecked': return UPDATES_COPY.unchecked;
    case 'idle':
      return u.checkedAt === undefined || u.checkedAt === null ? UPDATES_COPY.unchecked : fill(UPDATES_COPY.upToDate, { ago: agoLabel(u.checkedAt, now) });
  }
}

export function UpdatesRow({ s }: { s: StageApi }): JSX.Element {
  const now = useNow('minute');
  const [busy, setBusy] = useState(false);
  const u = s.updateStatus;
  const check = (): void => {
    setBusy(true);
    window.epo.checkForUpdate().then(
      () => setBusy(false),
      () => {
        setBusy(false);
        s.toast('error', UPDATES_COPY.error);
      },
    );
  };
  const restart = async (): Promise<void> => {
    const ok = await s.confirm({
      title: fill(UPDATES_COPY.restartTitle, { v: u?.version ?? '' }), body: UPDATES_COPY.restartBody,
      confirm: UPDATES_COPY.restartYes, dismiss: UPDATES_COPY.restartNo,
    });
    if (ok) await window.epo.installUpdate().catch(() => s.toast('error', UPDATES_COPY.installFailed));
  };
  let action: JSX.Element | null = null;
  if (u !== null && u.mode !== 'off') {
    if (u.state === 'ready' && u.mode === 'full') {
      action = <button type="button" class="set-btn set-btn--primary" onClick={() => void restart()}>{UPDATES_COPY.restart}</button>;
    } else if (u.state === 'available' && u.mode === 'notify') {
      action = <button type="button" class="set-btn" onClick={() => void window.epo.openLatestRelease()}>{UPDATES_COPY.openPage}</button>;
    } else {
      const working = busy || u.state === 'checking' || u.state === 'downloading';
      action = <button type="button" class="set-btn" disabled={working} onClick={check}>{UPDATES_COPY.check}</button>;
    }
  }
  return (
    <div class="set-row set-row--stack" data-row="updates">
      <div class="set-row__line">
        <span class="set-row__k">{UPDATES_COPY.title}</span>
        <span class="set-row__v">{u === null ? null : fill(UPDATES_COPY.version, { v: u.current })}</span>
      </div>
      <p class="set-sec__hint" role="status">
        {updateLine(u, now)}
      </p>
      {action}
    </div>
  );
}
