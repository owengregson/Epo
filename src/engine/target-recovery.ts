import type { Clock } from '../governors/clock';
import type { AcquireEndReason } from '../rim/acquisition-result';
import type { KnowledgeStore } from '../store/knowledge-store';
import { ENGINE, RECOVERY } from '../timing/config';
import * as log from '../utils/logger';
import { acquireFailureVerdict } from './decisions';
import type { EngineWait } from './engine-waits';
import type { StepResult } from './ports';
import type { FailureKind } from './recovery';

/** Compatibility recovery for pre-frontier targets with recent drain evidence. */
export function reviveRecentExhausted(
  deps: { store: KnowledgeStore; clock: Clock },
  revived: Set<string>,
): string | null {
  const cutoff = deps.clock.now() - RECOVERY.EXHAUSTED_REVERIFY_WINDOW_MS;
  for (const target of deps.store.exhaustedTargetsSince(cutoff)) {
    if (revived.has(target.accountPk)) continue;
    revived.add(target.accountPk);
    deps.store.setTargetStatus(target.accountPk, 'active');
    log.warn('engine: re-verifying recently exhausted target', {
      pk: target.accountPk, exhaustedAt: target.exhaustedAt,
    });
    return target.accountPk;
  }
  return null;
}

/** Failed reads retain the acquisition slot; repeated walls enter account-wide recovery. */
export async function acquisitionFailureBackoff(
  deps: { wait: EngineWait; recover(token: AbortController, kind: FailureKind): Promise<StepResult> },
  currentPk: string,
  endReason: AcquireEndReason,
  token: AbortController,
  walledCycles: number,
): Promise<{ step: StepResult; walledCycles: number }> {
  const verdict = acquireFailureVerdict(walledCycles, endReason, RECOVERY.WALLED_CYCLES_ENTRY);
  if (verdict.action === 'recover') {
    log.warn('engine: acquisition failing repeatedly — entering recovery', { target: currentPk, endReason });
    return { step: await deps.recover(token, verdict.kind), walledCycles: 0 };
  }
  log.warn('engine: acquire failed — backing off (target NOT exhausted)', {
    target: currentPk, endReason, walledCycles: verdict.walledCycles,
  });
  await deps.wait('engine:enrich-backoff', ENGINE.ENRICH_BACKOFF_MS);
  return { step: 'idle', walledCycles: verdict.walledCycles };
}
