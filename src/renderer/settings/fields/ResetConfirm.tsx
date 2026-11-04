/**
 * Reset to recommended (spec §6.7): the sheet lists exactly what would change, from main's own preview of
 * the reset (nothing is computed here), marks every line that would make Epo unfollow more or sooner, and
 * says what stays. Nothing is sent until Reset is pressed.
 */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ChangeLine, SettingsOp } from '@/shared/settings-ops';
import { ConfirmSheet } from '../ConfirmSheet';
import { labelOf, valueWord } from '../choice-words';
import { APP_COPY } from '../copy/choices';
import { fill } from '../format';
import type { StageApi } from '../stage-api';

export const RESET_OPS: readonly SettingsOp[] = [{ op: 'reset', scope: { kind: 'recommended' } }];

type Preview = { kind: 'loading' } | { kind: 'ok'; changes: readonly ChangeLine[] } | { kind: 'unavailable' };

export function ResetConfirm({ s, onClose }: { s: StageApi; onClose(): void }): JSX.Element {
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    window.epo.previewSettings(RESET_OPS).then(
      (r) => {
        if (alive) setPreview(r.kind === 'ok' ? { kind: 'ok', changes: r.changes } : { kind: 'unavailable' });
      },
      () => {
        if (alive) setPreview({ kind: 'unavailable' });
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const kept = fill(APP_COPY.resetKept, { a: s.view.protection.accounts.length, w: s.view.protection.words.length });
  const reset = (): void => {
    onClose();
    s.send('reset', RESET_OPS);
  };
  const changes = preview.kind === 'ok' ? preview.changes : [];
  return (
    <ConfirmSheet
      title={APP_COPY.resetTitle}
      onCancel={onClose}
      actions={[
        ...(preview.kind === 'ok' && changes.length === 0 ? [] : [{ label: APP_COPY.resetYes, tone: 'primary' as const, run: reset }]),
        { label: APP_COPY.resetNo, run: onClose },
      ]}
    >
      {preview.kind === 'loading' ? <p>{APP_COPY.resetLoading}</p> : null}
      {preview.kind === 'unavailable' ? <p>{APP_COPY.resetNoPreview}</p> : null}
      {preview.kind === 'ok' && changes.length === 0 ? <p>{APP_COPY.resetNothing}</p> : null}
      {changes.length > 0 ? (
        <>
          <p>{APP_COPY.resetLead}</p>
          <ul class="set-diff">
            {changes.map((c) => (
              <li key={c.key} class={c.loosensUnfollows ? 'set-diff__line is-loosening' : 'set-diff__line'}>
                <span class="set-diff__what">{labelOf(c.key)}</span>
                <span class="set-diff__values num">
                  {valueWord(c.key, c.before, s.view)} → {valueWord(c.key, c.after, s.view)}
                </span>
                {c.loosensUnfollows ? <span class="set-diff__warn">{APP_COPY.resetLoosens}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p class="set-sec__hint">{kept}</p>
    </ConfirmSheet>
  );
}
