/**
 * SettingsAutosave — the framework-free core behind useSettingsDraft. The
 * contract under test: edits debounce into ONE partial save of only the edited
 * keys, and those keys stay marked unsaved until the save RESOLVES — a rejected
 * save hands them back (no silent revert), surfaces the error, and the next
 * edit retries them.
 */
import {
  AUTOSAVE_MS,
  type AutosaveHost,
  type SaveState,
  SAVED_TTL_MS,
  SettingsAutosave,
} from '@/renderer/hooks/useSettingsDraft';
import type { Settings } from '@/types';

interface Deferred {
  promise: Promise<Settings>;
  resolve(value: Settings): void;
  reject(error: unknown): void;
}

const deferred = (): Deferred => {
  let resolve!: (value: Settings) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Settings>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Let the save promise's settle handlers run (fake timers leave microtasks alone). */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

interface Harness {
  autosave: SettingsAutosave;
  /** One entry per save() call: the partial that was sent. */
  calls: Array<Partial<Settings>>;
  /** The pending deferred for each save() call, in order. */
  pending: Deferred[];
  states: SaveState[];
  saved: Settings[];
  errors: unknown[];
  setDraft(part: Partial<Settings>): void;
}

const makeHarness = (): Harness => {
  let draft = { seed: 'alpha', dailyOperatingRate: 25, dailyHardCeiling: 80 } as Settings;
  const calls: Array<Partial<Settings>> = [];
  const pending: Deferred[] = [];
  const states: SaveState[] = [];
  const saved: Settings[] = [];
  const errors: unknown[] = [];
  const host: AutosaveHost = {
    getDraft: () => draft,
    save: (partial) => {
      calls.push(partial);
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    onSaved: (s) => saved.push(s),
    onSaveError: (e) => errors.push(e),
    onState: (s) => states.push(s),
  };
  return {
    autosave: new SettingsAutosave(host),
    calls,
    pending,
    states,
    saved,
    errors,
    setDraft: (part) => {
      draft = { ...draft, ...part };
    },
  };
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SettingsAutosave — debounce coalescing', () => {
  it('coalesces a burst of edits into ONE save carrying only the edited keys', () => {
    const h = makeHarness();
    h.setDraft({ seed: 'beta' });
    h.autosave.markDirty(['seed']);
    jest.advanceTimersByTime(AUTOSAVE_MS - 1);
    h.setDraft({ dailyHardCeiling: 90 });
    h.autosave.markDirty(['dailyHardCeiling']); // re-arms the debounce
    jest.advanceTimersByTime(AUTOSAVE_MS - 1);
    expect(h.calls).toHaveLength(0); // still within the window
    jest.advanceTimersByTime(1);
    expect(h.calls).toEqual([{ seed: 'beta', dailyHardCeiling: 90 }]);
  });

  it('reads values from the draft at fire time, not at edit time', () => {
    const h = makeHarness();
    h.setDraft({ seed: 'beta' });
    h.autosave.markDirty(['seed']);
    h.setDraft({ seed: 'gamma' }); // same key edited again before the debounce fires
    jest.advanceTimersByTime(AUTOSAVE_MS);
    expect(h.calls).toEqual([{ seed: 'gamma' }]);
  });
});

describe('SettingsAutosave — a resolved save', () => {
  it('confirms the keys (no longer edited) and decays Saved → idle', async () => {
    const h = makeHarness();
    h.setDraft({ seed: 'beta' });
    h.autosave.markDirty(['seed']);
    jest.advanceTimersByTime(AUTOSAVE_MS);
    expect([...h.autosave.editedKeys()]).toEqual(['seed']); // in flight: still protected

    const canonical = { seed: 'beta', dailyOperatingRate: 25 } as Settings;
    h.pending[0].resolve(canonical);
    await flush();
    expect(h.saved).toEqual([canonical]);
    expect(h.errors).toHaveLength(0);
    expect(h.autosave.editedKeys().size).toBe(0);
    expect(h.states).toEqual(['saving', 'saving', 'saved']); // edit → send → landed
    jest.advanceTimersByTime(SAVED_TTL_MS);
    expect(h.states[h.states.length - 1]).toBe('idle');
  });
});

describe('SettingsAutosave — a rejected save (the silent-revert fix)', () => {
  it('keeps the keys unsaved, surfaces the error, and the next edit retries them', async () => {
    const h = makeHarness();
    h.setDraft({ dailyHardCeiling: 90 });
    h.autosave.markDirty(['dailyHardCeiling']);
    jest.advanceTimersByTime(AUTOSAVE_MS);

    const boom = new Error('ipc failed');
    h.pending[0].reject(boom);
    await flush();
    expect(h.errors).toEqual([boom]);
    expect(h.saved).toHaveLength(0);
    // The load-bearing assertion: the key is STILL marked unsaved.
    expect([...h.autosave.editedKeys()]).toEqual(['dailyHardCeiling']);
    expect(h.states[h.states.length - 1]).toBe('error');

    // The next edit retries EVERYTHING still unsaved, not just the new key.
    h.setDraft({ seed: 'beta' });
    h.autosave.markDirty(['seed']);
    jest.advanceTimersByTime(AUTOSAVE_MS);
    expect(h.calls[1]).toEqual({ dailyHardCeiling: 90, seed: 'beta' });
    h.pending[1].resolve({ seed: 'beta' } as Settings);
    await flush();
    expect(h.autosave.editedKeys().size).toBe(0);
  });
});

describe('SettingsAutosave — edits during an in-flight save', () => {
  it('are not cleared by that save resolving; they persist in a follow-up save', async () => {
    const h = makeHarness();
    h.setDraft({ seed: 'beta' });
    h.autosave.markDirty(['seed']);
    jest.advanceTimersByTime(AUTOSAVE_MS);
    expect(h.calls).toHaveLength(1);

    // Edit the same key again while the first save is still in flight.
    h.setDraft({ seed: 'gamma' });
    h.autosave.markDirty(['seed']);
    h.pending[0].resolve({ seed: 'beta' } as Settings);
    await flush();
    // The newer edit survives the older resolution…
    expect([...h.autosave.editedKeys()]).toEqual(['seed']);
    expect(h.states[h.states.length - 1]).not.toBe('saved'); // still work pending
    // …and the re-armed debounce sends the newer value.
    jest.advanceTimersByTime(AUTOSAVE_MS);
    expect(h.calls[1]).toEqual({ seed: 'gamma' });
  });

  it('serializes: a debounce firing mid-flight waits for the settle instead of overlapping', async () => {
    const h = makeHarness();
    h.autosave.markDirty(['seed']);
    jest.advanceTimersByTime(AUTOSAVE_MS);
    h.autosave.markDirty(['dailyHardCeiling']);
    jest.advanceTimersByTime(AUTOSAVE_MS);
    expect(h.calls).toHaveLength(1); // second send parked behind the in-flight save
    h.pending[0].resolve({ seed: 'alpha' } as Settings);
    await flush();
    jest.advanceTimersByTime(AUTOSAVE_MS);
    expect(h.calls).toHaveLength(2);
    expect(Object.keys(h.calls[1])).toEqual(['dailyHardCeiling']);
  });
});

describe('SettingsAutosave — reset', () => {
  it('drops pending edits and lets an in-flight save settle silently', async () => {
    const h = makeHarness();
    h.autosave.markDirty(['seed']);
    jest.advanceTimersByTime(AUTOSAVE_MS);
    h.autosave.markDirty(['dailyHardCeiling']); // pending, not yet sent

    h.autosave.reset(); // e.g. a settings reset adopted a fresh canonical object
    expect(h.autosave.editedKeys().size).toBe(0);
    expect(h.states[h.states.length - 1]).toBe('idle');

    h.pending[0].resolve({ seed: 'stale' } as Settings);
    await flush();
    expect(h.saved).toHaveLength(0); // the superseded save must not re-adopt
    jest.advanceTimersByTime(AUTOSAVE_MS * 2);
    expect(h.calls).toHaveLength(1); // and nothing pending fires afterwards
  });
});
