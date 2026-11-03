import { type JSX } from 'preact';
import { settingsViewSignal, useShellControls } from '@/renderer/app/shell-context';
import { fill } from '@/renderer/settings/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { PRUNE_COPY } from './prune-copy';

/**
 * Prune · Protection (spec §7.8): what is protected, read only — the list is edited in one place,
 * Settings → Protection, which the link opens.
 */
export function PruneProtectionTile(): JSX.Element {
  const view = settingsViewSignal.value;
  const { openSettings } = useShellControls();
  const p = view?.protection ?? null;
  return (
    <Card>
      <CardHeader icon="shield-halved">{PRUNE_COPY.protection}</CardHeader>
      <CardBody>
        {p === null ? (
          <p class="hint">{PRUNE_COPY.protectionUnknown}</p>
        ) : (
          <>
            <p class="num">{fill(PRUNE_COPY.protectionLine, { a: p.accounts.length, w: p.words.length })}</p>
            {p.keepVerified ? <p class="hint">{PRUNE_COPY.protectionVerified}</p> : null}
            <p class="hint">{PRUNE_COPY.protectionNever}</p>
          </>
        )}
        <button type="button" class="link-btn" onClick={() => openSettings({ section: 'protection' })}>
          {PRUNE_COPY.protectionEdit}
        </button>
      </CardBody>
    </Card>
  );
}
