/**
 * The session capability and its binding rule.
 *
 * The rule under test is the one that replaces ~40 `if (graph === null)`
 * guards: a dependent declared over a session is BUILT on open and DISPOSED on
 * close — exactly once each, never overlapping, and never left alive after the
 * capability vanishes.
 */

import fc from 'fast-check';
import { bindToSession, createSession } from '@/kernel/session';

test('open/close notify listeners with the value that opened and closed', () => {
  const session = createSession<{ pk: string }>();
  const opened: string[] = [];
  const closed: string[] = [];
  session.onOpen((v) => opened.push(v.pk));
  session.onClose((v) => closed.push(v.pk));

  expect(session.current()).toBeNull();
  const a = { pk: 'a' };
  session.open(a);
  expect(session.current()).toBe(a);
  session.open(a); // same value: no transition
  session.close();
  session.close(); // already closed: no transition

  expect(opened).toEqual(['a']);
  expect(closed).toEqual(['a']);
  expect(session.current()).toBeNull();
});

test('opening over a live value closes the old one first (identity swap)', () => {
  const session = createSession<string>();
  const events: string[] = [];
  session.onOpen((v) => events.push(`open:${v}`));
  session.onClose((v) => events.push(`close:${v}`));
  session.open('first');
  session.open('second');
  expect(events).toEqual(['open:first', 'close:first', 'open:second']);
});

test('unsubscribing during a notification does not shorten that round', () => {
  const session = createSession<number>();
  const seen: string[] = [];
  const off = session.onOpen(() => {
    seen.push('a');
    off();
  });
  session.onOpen(() => seen.push('b'));
  session.open(1);
  session.close();
  session.open(2);
  expect(seen).toEqual(['a', 'b', 'b']);
});

test('a dependent is built on open and disposed on close', async () => {
  const session = createSession<string>();
  const log: string[] = [];
  const binding = bindToSession(session, (pk) => ({
    pk,
    start: () => {
      log.push(`start:${pk}`);
    },
    dispose: () => {
      log.push(`dispose:${pk}`);
    },
  }));

  expect(binding.current()).toBeNull();
  session.open('99');
  await binding.settled();
  expect(binding.current()?.pk).toBe('99');
  session.close();
  await binding.settled();
  expect(binding.current()).toBeNull();
  expect(log).toEqual(['start:99', 'dispose:99']);
});

test('binding to an already-open session builds immediately', async () => {
  const session = createSession<string>();
  session.open('7');
  const binding = bindToSession(session, (pk) => ({ pk }));
  await binding.settled();
  expect(binding.current()?.pk).toBe('7');
  await binding.dispose();
  expect(binding.current()).toBeNull();
});

test('a throwing start or dispose is reported, never propagated', async () => {
  const session = createSession<string>();
  const errors: string[] = [];
  const binding = bindToSession(
    session,
    () => ({
      start: () => {
        throw new Error('start boom');
      },
      dispose: () => {
        throw new Error('dispose boom');
      },
    }),
    (phase) => errors.push(phase),
  );
  session.open('1');
  await binding.settled();
  session.close();
  await binding.settled();
  expect(errors).toEqual(['start', 'dispose']);
});

test('for any open/close sequence: builds == opens, disposes == closes, never two alive', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.oneof(fc.constant('open'), fc.constant('close')), { minLength: 1, maxLength: 24 }),
      async (ops) => {
        const session = createSession<number>();
        let alive = 0;
        let maxAlive = 0;
        let builds = 0;
        let disposes = 0;
        const binding = bindToSession(session, () => ({
          start: () => {
            builds += 1;
            alive += 1;
            maxAlive = Math.max(maxAlive, alive);
          },
          dispose: () => {
            disposes += 1;
            alive -= 1;
          },
        }));

        let opens = 0;
        let closes = 0;
        let open = false;
        for (const [i, op] of ops.entries()) {
          if (op === 'open') {
            if (open) closes += 1; // the swap closes the live value first
            session.open(i);
            opens += 1;
            open = true;
          } else {
            if (open) closes += 1;
            session.close();
            open = false;
          }
          await binding.settled();
        }
        await binding.dispose();
        if (open) closes += 1;

        expect(builds).toBe(opens);
        expect(disposes).toBe(closes);
        expect(maxAlive).toBeLessThanOrEqual(1);
        expect(binding.current()).toBeNull();
      },
    ),
    { numRuns: 60 },
  );
});
