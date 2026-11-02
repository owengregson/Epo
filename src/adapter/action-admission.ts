import type { ActorOptions, AdapterTab } from './actor-types';
import { ActionAbortedError, ActionBlockedError } from './errors';
import { SURFACE } from './ig-surface';

/** Bind navigation, account identity and durable dispatch to a single mutation. */
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
  return async () => {
    const check = (): void => {
      checkAbort();
      if (expectedPk !== undefined && !profileMatches(d.tab.currentUrl(), username)) {
        throw new ActionBlockedError(component, 'profile changed before mutation');
      }
    };
    check();
    await d.beforeMutation?.();
    check();
    onDispatch?.();
  };
}

function profileMatches(url: string, username: string): boolean {
  try {
    const current = new URL(url);
    const expected = new URL(SURFACE.profileUrl(username));
    return current.origin === expected.origin && current.pathname.toLowerCase() === expected.pathname.toLowerCase();
  } catch { return false; }
}
