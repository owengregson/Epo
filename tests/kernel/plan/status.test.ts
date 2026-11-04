/** Session budgets survive millisecond rounding and drawn gaps; lateness and hard walls still bind. */
import { drawBase } from '@/kernel/plan/draw';
import { SESSION_BOUNDARY_MS } from '@/kernel/plan/layout';
import { NO_USAGE, sessionStatus } from '@/kernel/plan/status';
import { MS_PER_HOUR } from '@/kernel/units';
import { drawInput } from '../../kit/plan';

const input = drawInput(new Date(2026, 10, 3, 12).getTime());
const plan = drawBase(input);
const original = plan.sessions[0];
const session = { ...original, budget: 3, expectedEndAt: original.startAt + 300,
  tempo: { ...original.tempo, gap: { ...original.tempo.gap, targetMeanMs: 100.1 } } };
const next = { ...plan.sessions[1], startAt: original.startAt + 3 * MS_PER_HOUR };
const example = { ...plan, sessions: [session, next] };

test('an unjoined session at its exact start retains the whole drawn budget despite rounded expected length', () => {
  expect(sessionStatus(example, 0, session.startAt, NO_USAGE)).toMatchObject({ open: true, budget: 3 });
});

test('a joined session spends its budget after the expected duration, until the next session boundary', () => {
  const usage = { auto: 1, follow: 1, perSession: [1], joinedAt: [session.startAt] };
  const closesAt = next.startAt - SESSION_BOUNDARY_MS;
  expect(sessionStatus(example, 0, session.expectedEndAt + 301, usage)).toMatchObject({ open: true, budget: 3, closesAt });
  expect(sessionStatus(example, 0, closesAt, usage)).toMatchObject({ open: false, state: 'partial' });
});

test('a genuinely late join retains only the budget that fit when it joined', () => {
  const joinedAt = session.startAt + 150;
  const usage = { auto: 1, follow: 1, perSession: [1], joinedAt: [joinedAt] };
  expect(sessionStatus(example, 0, joinedAt, usage)).toMatchObject({ budget: 1, open: false, state: 'done' });
  expect(sessionStatus(example, 0, session.expectedEndAt, NO_USAGE)).toMatchObject({ budget: 0, state: 'skipped' });
});

test('a joined final session closes at quiet hours or the day end, whichever comes first', () => {
  const startAt = new Date(2026, 10, 3, 21).getTime();
  const quietAt = new Date(2026, 10, 3, 23, 30).getTime();
  const last = { ...session, startAt, expectedEndAt: startAt + MS_PER_HOUR };
  const p = { ...plan, window: { ...plan.window, endsAt: quietAt + MS_PER_HOUR }, sessions: [last] };
  const usage = { auto: 1, follow: 1, perSession: [1], joinedAt: [startAt] };
  const quiet = { startMinute: 23 * 60 + 30, endMinute: 6 * 60 };
  expect(sessionStatus(p, 0, quietAt - 1, usage, quiet)).toMatchObject({ open: true, closesAt: quietAt });
  expect(sessionStatus(p, 0, quietAt, usage, quiet)).toMatchObject({ open: false, state: 'partial' });
  expect(sessionStatus(p, 0, quietAt, usage).closesAt).toBe(p.window.endsAt);
});
