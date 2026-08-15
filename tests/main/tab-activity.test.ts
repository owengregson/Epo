/**
 * TabActivity — the veil's stateful authority. Named holds from every
 * work source; active exactly while ANY hold exists; ref-counted ops,
 * level-triggered stream signals, and exit-safe scoped holds.
 */
import { TabActivity } from '@/main/tab-activity';

interface Change {
  active: boolean;
  holds: string[];
}

const build = (): { a: TabActivity; changes: Change[] } => {
  const changes: Change[] = [];
  const a = new TabActivity((active, holds) => changes.push({ active, holds }));
  return { a, changes };
};

test('starts inactive with no holds', () => {
  const { a, changes } = build();
  expect(a.active()).toBe(false);
  expect(a.holds()).toEqual([]);
  expect(changes).toEqual([]);
});

test('hold raises, release lowers — with the hold names reported', () => {
  const { a, changes } = build();
  a.hold('prune-scan');
  expect(a.active()).toBe(true);
  a.release('prune-scan');
  expect(a.active()).toBe(false);
  expect(changes).toEqual([
    { active: true, holds: ['prune-scan'] },
    { active: false, holds: [] },
  ]);
});

test('overlapping holds keep it active until the LAST one releases', () => {
  const { a, changes } = build();
  a.hold('build');
  a.hold('prune-run'); // veil must not dip at the hand-off
  a.release('build');
  expect(a.active()).toBe(true);
  a.release('prune-run');
  expect(a.active()).toBe(false);
  // Four composition changes, active only flipping at the ends.
  expect(changes.map((c) => c.active)).toEqual([true, true, true, false]);
});

test('holds are ref-counted per name (two manual ops in flight)', () => {
  const { a } = build();
  a.hold('manual-action');
  a.hold('manual-action');
  a.release('manual-action');
  expect(a.active()).toBe(true); // one op still running
  a.release('manual-action');
  expect(a.active()).toBe(false);
});

test('releasing an absent name is an idempotent no-op (backstop releases)', () => {
  const { a, changes } = build();
  a.release('growth-start');
  expect(a.active()).toBe(false);
  expect(changes).toEqual([]);
  // Bridge + backstop double-release: still clean.
  a.hold('growth-start');
  a.release('growth-start');
  a.release('growth-start');
  expect(a.active()).toBe(false);
  expect(changes.length).toBe(2);
});

test('signal is level-triggered: repeated same-level signals never stack', () => {
  const { a, changes } = build();
  a.signal('growth-loop', true);
  a.signal('growth-loop', true); // every `running` status emit
  a.signal('growth-loop', true);
  expect(changes.length).toBe(1);
  a.signal('growth-loop', false); // one `paused` emit clears it fully
  expect(a.active()).toBe(false);
  a.signal('growth-loop', false);
  expect(changes.length).toBe(2);
});

test('the start-bridge hand-off never dips: signal on, then bridge release', () => {
  const { a, changes } = build();
  a.hold('growth-start'); // startEngine entry
  a.signal('growth-loop', true); // first status emit
  a.release('growth-start'); // bridge retires
  expect(a.active()).toBe(true);
  expect(changes.every((c) => c.active)).toBe(true); // never went inactive
  a.signal('growth-loop', false); // engine paused/stopped
  expect(a.active()).toBe(false);
});

test('with() releases on resolve AND on throw', async () => {
  const { a } = build();
  await a.with('seed-check', async () => 'ok');
  expect(a.active()).toBe(false);

  await expect(
    a.with('manual-read', async () => {
      expect(a.active()).toBe(true);
      throw new Error('scrape failed');
    }),
  ).rejects.toThrow('scrape failed');
  expect(a.active()).toBe(false);
});
