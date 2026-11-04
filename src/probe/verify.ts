/** Read-only L1 parsing check. A failed step, wall or drift stops the sequence; no retry or mutation is invoked. */
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Actor } from '@/adapter/actor';
import { TabUnresponsiveError } from '@/adapter/errors';
import { resolveOwnUsername } from '@/adapter/identity';
import { SURFACE } from '@/adapter/ig-surface';
import { Sentinel } from '@/adapter/sentinel';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import type { VerifyEvidence } from '@/probe/verify-evidence';
import { TabProfileVisitor } from '@/rim/profile-visit';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { sleep } from '@/timing/primitives';
import { cryptoUniform } from '@/utils/entropy';
import * as logger from '@/utils/logger';

const settle = (signal: AbortSignal): Promise<void> => sleep(5000 + cryptoUniform() * 3000, signal);
const summary = (visit: ProfileVisit): unknown => visit.ok
  ? { ok: true, pk: visit.obs.accountPk, ...visit.obs.fields, viewer: visit.viewer,
    tier: visit.tier, partial: visit.partial, presence: visit.presence } : visit;

function validProfile(visit: ProfileVisit, target: boolean): boolean {
  if (!visit.ok || visit.tier !== 'canonical' || visit.partial !== false) return false;
  const { counts, bio, isVerified, isPrivate, relationship } = visit.presence ?? {};
  return counts === 'read' && bio === 'read' && isVerified === 'read'
    && (relationship === 'read' || (!target && relationship === 'self'))
    && (!target || (isPrivate === 'read' && visit.obs.fields.isPrivate === false
      && visit.viewer.following === true && visit.viewer.requested === false));
}

export async function verifyProbe(tab: InstagramTab, evidence: VerifyEvidence, target: string): Promise<void> {
  const { result, abort, observer } = evidence;
  if (observer === null) throw new Error('verify observer was not installed before initial navigation');
  const abortSignal = () => abort.signal;
  const interactor = createTabInteractor(tab, { abortSignal });
  const actor = new Actor(tab, { interactor, abortSignal });
  const visitor = new TabProfileVisitor({ tab, observer, sentinel: new Sentinel(tab), abortSignal });
  const step = async <T>(name: string, fn: () => Promise<T>, accepts: (value: T) => boolean, format: (value: T) => unknown = (v) => v) => {
    evidence.begin(name);
    await evidence.check(tab);
    logger.info('probe.verify step', { step: name });
    evidence.assert();
    const value = await evidence.wait(fn());
    result[name] = format(value);
    if (!accepts(value)) evidence.stop('step-result', { step: name, result: result[name] });
    evidence.assert();
    await evidence.check(tab);
    await evidence.wait(settle(abort.signal));
    await evidence.check(tab);
    writeFileSync(path.join(evidence.out, `${name}.png`), await evidence.wait(tab.captureScreenshot()));
  };
  await evidence.check(tab);
  const own = await evidence.wait(resolveOwnUsername(tab, { interactor, signal: abort.signal }));
  result.ownUsername = own ?? null;
  if (!own) { evidence.stop('own-username-unavailable'); evidence.assert(); return; }
  await step('visit-own', () => visitor.visit(own), (visit) => validProfile(visit, false), summary);
  await step('visit-target', () => visitor.visit(target), (visit) => validProfile(visit, true), summary);
  const nx = `epo_nx_${cryptoUniform().toString(36).slice(2, 10)}${cryptoUniform().toString(36).slice(2, 8)}`;
  await step('visit-nonexistent', () => visitor.visit(nx), (visit) => !visit.ok && visit.kind === 'gone', summary);
  await step('home', () => tab.goto(IG_HOME_URL), () => true);
  await step('drawer-open', () => actor.clickNotifications(), (clicked) => clicked);
  await step('drawer-follows', () => actor.clickNotificationsFollowsFilter(), (clicked) => clicked);
  await step('drawer-requests', () => actor.clickFollowRequestsEntry(), (clicked) => clicked);
  await step('drawer-close', () => actor.clickNotificationsClose(), (clicked) => clicked);
  result['drawer-closed'] = !(await evidence.wait(tab.evaluate<{ found: boolean }>(SURFACE.locateNotificationsCloseScript()))).found;
  if (!result['drawer-closed']) { evidence.stop('drawer-still-open'); evidence.assert(); }
  await step('own-profile-link', async () => {
    let clicked: boolean;
    try { clicked = await actor.clickOwnProfileLink(); }
    catch (error) {
      // A route change can race the press/release ACK (ADR 0307). Only this
      // read-only navigation re-observes the destination; nothing is retried.
      if (!(error instanceof TabUnresponsiveError && error.phase === 'post-click'
        && (error.component === 'input:document-changed-after-press'
          || error.component === 'input:document-changed-during-press'))) throw error;
      result['own-profile-link-uncertainty'] = {
        component: error.component, phase: error.phase, timeoutMs: error.timeoutMs,
      };
      clicked = true;
    }
    evidence.assert();
    await evidence.wait(sleep(3000, abort.signal));
    evidence.assert();
    return { clicked, url: tab.currentUrl() };
  }, (value) => value.clicked && SURFACE.usernameFromProfileUrl(value.url)?.toLowerCase() === own.toLowerCase());
}
