import { prepareAction } from '@/adapter/action-admission';
import { ActionAbortedError, ActionBlockedError, ActionDeferredError } from '@/adapter/errors';
import { ScriptedTab } from '../kit/tabs';

test('an expected PK requires a verifier, and dispatch is journaled only after admission', async () => {
  const tab = new ScriptedTab();
  await expect(prepareAction({ tab }, 'follow', 'alice', 'a')).rejects.toBeInstanceOf(ActionBlockedError);
  const order: string[] = [];
  const dispatch = await prepareAction({ tab,
    prepareProfile: async (name, pk, action) => {
      expect([name, pk, action]).toEqual(['alice', 'a', 'follow']);
      order.push('verified');
      await tab.goto('https://www.instagram.com/alice/');
    },
    beforeMutation: async () => { order.push('admitted'); },
  }, 'follow', 'alice', 'a', () => order.push('journal-dispatched'));
  expect(order).toEqual(['verified']);
  await dispatch();
  expect(order).toEqual(['verified', 'admitted', 'journal-dispatched']);
});

test.each(['before-admission', 'during-admission'] as const)('navigation %s cannot dispatch against a different profile', async (when) => {
  const tab = new ScriptedTab();
  const journal = jest.fn();
  const dispatch = await prepareAction({ tab,
    prepareProfile: async () => { await tab.goto('https://www.instagram.com/alice/'); },
    beforeMutation: async () => { if (when === 'during-admission') await tab.goto('https://www.instagram.com/bob/'); },
  }, 'unfollow', 'alice', 'a', journal);
  if (when === 'before-admission') await tab.goto('https://www.instagram.com/bob/');
  await expect(dispatch()).rejects.toBeInstanceOf(ActionBlockedError);
  expect(journal).not.toHaveBeenCalled();
});

test('a stopped run cannot be revived by replacing the active abort token during asynchronous admission', async () => {
  const tab = new ScriptedTab();
  let token = new AbortController();
  const original = token;
  const journal = jest.fn();
  const dispatch = await prepareAction({ tab, abortSignal: () => token.signal,
    prepareProfile: async () => { await tab.goto('https://www.instagram.com/alice/'); },
    beforeMutation: async () => { original.abort(); token = new AbortController(); },
  }, 'follow', 'alice', 'a', journal);
  await expect(dispatch()).rejects.toBeInstanceOf(ActionAbortedError);
  expect(journal).not.toHaveBeenCalled();
});

test('abort during fresh profile preparation stops before an admission callback is returned', async () => {
  const tab = new ScriptedTab();
  const token = new AbortController();
  const journal = jest.fn();
  await expect(prepareAction({ tab, abortSignal: () => token.signal,
    prepareProfile: async () => { token.abort(); },
  }, 'follow', 'alice', 'a', journal)).rejects.toBeInstanceOf(ActionAbortedError);
  expect(journal).not.toHaveBeenCalled();
});

describe('one admission per action (spec §11.1 F1)', () => {
  /** A prepared dispatch for alice whose admission and journal mark are counted. */
  async function prepared(beforeMutation: () => Promise<void> = async () => {}) {
    const tab = new ScriptedTab();
    const token = new AbortController();
    const admit = jest.fn(beforeMutation);
    const journal = jest.fn();
    const dispatch = await prepareAction({ tab, abortSignal: () => token.signal, beforeMutation: admit,
      prepareProfile: async () => { await tab.goto('https://www.instagram.com/alice/'); },
    }, 'unfollow', 'alice', 'a', journal);
    return { tab, token, admit, journal, dispatch };
  }

  test('later calls — the later layers of the same action — admit and journal nothing again', async () => {
    const { admit, journal, dispatch } = await prepared();
    await dispatch();
    await dispatch();
    await dispatch();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledTimes(1);
  });

  test('a later call still checks the profile and the stop', async () => {
    const changed = await prepared();
    await changed.dispatch();
    await changed.tab.goto('https://www.instagram.com/bob/');
    await expect(changed.dispatch()).rejects.toBeInstanceOf(ActionBlockedError);

    const stopped = await prepared();
    await stopped.dispatch();
    stopped.token.abort();
    await expect(stopped.dispatch()).rejects.toBeInstanceOf(ActionAbortedError);
    expect(stopped.admit).toHaveBeenCalledTimes(1);
  });

  test('a refused admission refuses every later call: nothing is ever pressed after a refusal', async () => {
    const refusal = new ActionDeferredError('cadence: deadline not reached');
    const { admit, journal, dispatch } = await prepared(async () => { throw refusal; });
    await expect(dispatch()).rejects.toBe(refusal);
    await expect(dispatch()).rejects.toBe(refusal);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(journal).not.toHaveBeenCalled();
  });
});
