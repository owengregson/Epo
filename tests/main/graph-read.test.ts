import { CHANNELS } from '@/ipc/contract';
import { registerEpoIpc } from '@/main/ipc';
import { initialStatus } from '@/main/update-core';
import { builtFoundation, cleanupMainHarness, foundationStore, makeIgSession, newFoundation } from '../kit/main-harness';

const registered = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => registered.set(channel, fn),
    removeHandler: (channel: string) => registered.delete(channel),
  },
}));

afterAll(cleanupMainHarness);

test('a graph read without an account remains null', async () => {
  const { foundation } = newFoundation({ igSession: makeIgSession(null) });
  try { expect(await foundation.graphSnapshot()).toBeNull(); }
  finally { await foundation.dispose(); }
});

test('a store read failure is explicitly unavailable, and a later successful read recovers', async () => {
  const { foundation } = await builtFoundation();
  const fail = jest.spyOn(foundationStore(foundation), 'graphSnapshotRows').mockImplementation(() => { throw new Error('store closed'); });
  try {
    expect(await foundation.graphSnapshot()).toEqual({ unavailable: true });
    fail.mockRestore();
    expect(await foundation.graphSnapshot()).toHaveProperty('pks');
  } finally { fail.mockRestore(); await foundation.dispose(); }
});

test('the real IPC fallback preserves unavailable, and stage IPC forwards reduced motion', async () => {
  const { foundation, tab } = newFoundation();
  const update = initialStatus('off', 'test');
  const setStage = jest.fn();
  const dispose = registerEpoIpc({
    foundation, tab, setStage,
    updater: { current: () => update, check: async () => update, install: () => update, openLatest: async () => {} },
  });
  const graph = registered.get(CHANNELS.graphSnapshot);
  const stage = registered.get(CHANNELS.setStage);
  const read = jest.spyOn(foundation, 'graphSnapshot');
  try {
    read.mockRejectedValueOnce(new Error('build refused'));
    expect(await graph?.({})).toEqual({ unavailable: true });
    read.mockResolvedValueOnce(null);
    expect(await graph?.({})).toBeNull();
    await stage?.({}, 'tab', false, true);
    expect(setStage).toHaveBeenLastCalledWith('tab', false, true);
    await stage?.({}, 'tab', false, 'invalid');
    expect(setStage).toHaveBeenLastCalledWith('tab', false, false);
  } finally { read.mockRestore(); dispose(); await foundation.dispose(); }
});
