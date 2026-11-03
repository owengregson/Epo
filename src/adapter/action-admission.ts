import type { ActorOptions, AdapterTab } from './actor-types';
import { ActionAbortedError, ActionBlockedError } from './errors';
import { SURFACE } from './ig-surface';

/**
 * Bind navigation, identity and durable dispatch to one mutation, admitted and journaled at most once
 * (ADR 0308): later calls, the later confirm layers, re-run only the stop and same-profile check.
 */
export async function prepareAction(d: Pick<ActorOptions, 'prepareProfile' | 'beforeMutation' | 'abortSignal'> & {
  tab: AdapterTab;
}, action: 'follow' | 'unfollow', username: string, expectedPk?: string, onDispatch?: () => void): Promise<() => Promise<void>> {
  const component = `actor.${action}`;
  const originalSignal = d.abortSignal?.();
  const checkAbort = (): void => {
    if (originalSignal?.aborted || d.abortSignal?.()?.aborted || originalSignal !== d.abortSignal?.()) throw new ActionAbortedError(component);
  };
  checkAbort();
  if (expectedPk !== undefined) {
    if (!d.prepareProfile) throw new ActionBlockedError(component, 'identity verification unavailable');
    await d.prepareProfile(username, expectedPk, action);
  } else await d.tab.goto(SURFACE.profileUrl(username));
  checkAbort();
  const check = (): void => {
    checkAbort();
    if (expectedPk !== undefined && !profileMatches(d.tab.currentUrl(), username)) {
      throw new ActionBlockedError(component, 'profile changed before mutation');
    }
  };
  let admission: Promise<void> | null = null;
  return () => {
    if (admission !== null) return admission.then(check);
    admission = (async () => {
      check();
      await d.beforeMutation?.();
      check();
      onDispatch?.();
    })();
    return admission;
  };
}

function profileMatches(url: string, username: string): boolean {
  try {
    const current = new URL(url);
    const expected = new URL(SURFACE.profileUrl(username));
    return current.origin === expected.origin && current.pathname.toLowerCase() === expected.pathname.toLowerCase();
  } catch { return false; }
}
