/**
 * Advanced extras of two Easy sections (spec §6.5, §6.6, §7.8): Protection gets keyword matching, the
 * protection list's state with its review action, and the kept table; Practice & app gets "Start over from
 * the older version's settings" (the deliberate re-migration, confirmed first).
 */
import type { JSX } from 'preact';
import { INTENT_ROWS_COPY, KEPT_COPY } from '../copy/advanced';
import { APP_COPY } from '../copy/choices';
import { PROTECTION_COPY } from '../copy/fields';
import { NOTICE_ACTIONS } from '../copy/notices';
import { ControlError, Sub } from '../fields/controls';
import type { StageApi } from '../stage-api';
import { ChoiceRow } from './FineTune';
import { KeptTable } from './KeptTable';

const MATCHES = ['anywhere', 'whole-word'] as const;

export function ProtectionExtras({ s }: { s: StageApi }): JSX.Element {
  const state = s.view.protectionState;
  const kept = s.facts?.built ? (s.facts.protection?.kept.total ?? 0) : 0;
  return (
    <>
      <ChoiceRow
        s={s}
        k="protect:wordMatch"
        label={PROTECTION_COPY.match}
        help={INTENT_ROWS_COPY.matchHelp}
        items={MATCHES}
        selected={s.view.protection.wordMatch}
        render={(m) => (m === 'anywhere' ? PROTECTION_COPY.matchAnywhere : PROTECTION_COPY.matchWhole)}
        ops={(m) => [{ op: 'protect-rule', rule: 'wordMatch', value: m }]}
      />
      <div class="set-param set-param--intent" data-row="protection.state">
        <div class="set-param__copy">
          <span class="set-param__label">{PROTECTION_COPY.state}</span>
        </div>
        <div class="set-param__control">
          <span class="set-param__line">
            {state === 'ready' ? PROTECTION_COPY.stateReady : state === 'needs-review' ? PROTECTION_COPY.stateReview : PROTECTION_COPY.stateUnavailable}
            {state === 'ready' ? null : (
              <button type="button" class="set-btn" onClick={() => s.send('protection:ack', [{ op: 'acknowledge-protection' }])}>
                {NOTICE_ACTIONS.protectionRight}
              </button>
            )}
          </span>
          <ControlError s={s} k="protection:ack" />
        </div>
      </div>
      <Sub>{KEPT_COPY.title}</Sub>
      <KeptTable refresh={kept} />
    </>
  );
}

export function AppExtras({ s }: { s: StageApi }): JSX.Element {
  const startOver = async (): Promise<void> => {
    const ok = await s.confirm({
      title: APP_COPY.startOverTitle, body: APP_COPY.startOverBody, confirm: APP_COPY.startOverYes, dismiss: APP_COPY.cancel, danger: true,
    });
    if (ok) s.send('migration', [{ op: 'migration', action: 'remigrate-from-v1' }]);
  };
  return (
    <div class="set-param set-param--intent" data-row="startOver">
      <div class="set-param__copy">
        <span class="set-param__label">{APP_COPY.startOver}</span>
        <span class="set-param__help">{APP_COPY.startOverHelp}</span>
      </div>
      <div class="set-param__control">
        <span class="set-param__line">
          <button type="button" class="set-btn set-btn--danger" onClick={() => void startOver()}>
            {APP_COPY.startOverYes}
          </button>
        </span>
        <ControlError s={s} k="migration" />
      </div>
    </div>
  );
}
