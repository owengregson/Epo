import type { JSX } from 'preact';
import { Icon } from '@/renderer/ui/Icon';
import type { SettingsNotice } from '@/shared/settings-view';
import { NOTICE_ACTIONS, NOTICE_COPY } from './copy/notices';
import { fill, minuteLabel } from './format';
import type { StageApi } from './stage-api';

/** A notice's sentence, its slots filled from its data (or, for quiet hours, from the view). */
function sentence(n: SettingsNotice, s: StageApi): string {
  if (n.kind === 'needs-review' && s.view.protectionState === 'unavailable') return NOTICE_ACTIONS.unavailable;
  const q = s.view.easy.quietHours;
  const extra: Record<string, string> = q === null ? {} : { start: minuteLabel(q.startMinute), end: minuteLabel(q.endMinute) };
  return fill(NOTICE_COPY[n.kind], { ...extra, ...n.data });
}

/** The refused migration's recovery sheet: only the two recovery ops are offered (spec §6.10). */
function RecoverySheet({ n, s }: { n: SettingsNotice; s: StageApi }): JSX.Element {
  const fresh = async (): Promise<void> => {
    const ok = await s.confirm({
      title: NOTICE_ACTIONS.startRecommendedTitle, body: NOTICE_ACTIONS.startRecommendedBody,
      confirm: NOTICE_ACTIONS.startRecommendedYes, dismiss: NOTICE_ACTIONS.cancel,
    });
    if (ok) s.send('migration', [{ op: 'migration', action: 'start-from-recommended' }]);
  };
  return (
    <div class="set-notice set-notice--sheet" data-tone="error" role="alert">
      <Icon name="triangle-exclamation" />
      <div class="set-notice__body">
        <p>{sentence(n, s)}</p>
        <div class="set-notice__actions">
          <button type="button" class="set-btn set-btn--primary" onClick={() => s.send('migration', [{ op: 'migration', action: 'retry' }])}>
            {NOTICE_ACTIONS.tryAgain}
          </button>
          <button type="button" class="set-btn" onClick={() => void fresh()}>
            {NOTICE_ACTIONS.startRecommended}
          </button>
        </div>
      </div>
    </div>
  );
}

function Notice({ n, s }: { n: SettingsNotice; s: StageApi }): JSX.Element {
  if (n.kind === 'migration-refused') return <RecoverySheet n={n} s={s} />;
  const dismiss = (): void => s.send(`notice:${n.id}`, [{ op: 'dismiss-notice', id: n.id }]);
  const actions: JSX.Element[] = [];
  if (n.kind === 'needs-review') {
    actions.push(
      <button key="review" type="button" class="set-btn" onClick={() => s.scrollTo('protection')}>
        {NOTICE_ACTIONS.reviewProtection}
      </button>,
      <button key="ack" type="button" class="set-btn set-btn--primary" onClick={() => s.send('protection:ack', [{ op: 'acknowledge-protection' }])}>
        {NOTICE_ACTIONS.protectionRight}
      </button>,
    );
  } else if (n.kind === 'older-version-changed') {
    actions.push(
      <button key="add" type="button" class="set-btn set-btn--primary" onClick={() => s.send('older', [{ op: 'import-older-version' }])}>
        {NOTICE_ACTIONS.addThem}
      </button>,
      <button key="ignore" type="button" class="set-btn" onClick={dismiss}>
        {NOTICE_ACTIONS.ignore}
      </button>,
    );
  } else if (n.kind === 'override-stale') {
    actions.push(
      <button key="review" type="button" class="set-btn" onClick={() => s.openAdvanced('pace')}>
        {NOTICE_ACTIONS.review}
      </button>,
    );
  }
  if (n.dismissible && n.kind !== 'older-version-changed') {
    actions.push(
      <button key="dismiss" type="button" class="link-btn" onClick={dismiss}>
        {NOTICE_ACTIONS.dismiss}
      </button>,
    );
  }
  return (
    <div class="set-notice" data-tone={n.tone} role={n.tone === 'info' ? 'status' : 'alert'}>
      <Icon name={n.tone === 'info' ? 'circle-exclamation' : 'shield-halved'} />
      <div class="set-notice__body">
        <p>{sentence(n, s)}</p>
        {actions.length > 0 ? <div class="set-notice__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Every notice the view carries, the recovery sheet first. */
export function Notices({ s }: { s: StageApi }): JSX.Element | null {
  const list = [...s.view.notices].sort((a, b) => Number(b.kind === 'migration-refused') - Number(a.kind === 'migration-refused'));
  if (list.length === 0) return null;
  return (
    <div class="set-notices">
      {list.map((n) => <Notice key={n.id} n={n} s={s} />)}
    </div>
  );
}
