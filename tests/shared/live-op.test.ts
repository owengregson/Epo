/**
 * The live-op sentence (spec C.15.7, L-COPY): one plain sentence per op for the sidebar's now line, and the
 * veil shows the same sentence. The veil carries a running count beside its label (its bar and counter), so
 * the label stays steady while a list read advances and the veil's per-phase timer keeps running.
 */
import { type ActivityInfo, type LiveOp, liveOpLead, liveOpProgress, liveOpText, toVeilInfo } from '@/shared/live-op';

/** One of every op, with the sentence the sidebar shows for it. */
const SENTENCES: ReadonlyArray<[LiveOp, string]> = [
  [{ op: 'follow', username: 'jane' }, 'Following @jane'],
  [{ op: 'unfollow', username: 'carl' }, 'Unfollowing @carl'],
  [{ op: 'accept-request', username: 'dana' }, "Accepting @dana's follow request"],
  [{ op: 'open-list', list: 'followers', of: 'studio.lumen' }, "Opening @studio.lumen's followers"],
  [{ op: 'open-list', list: 'following', of: 'studio.lumen' }, "Opening @studio.lumen's following"],
  [{ op: 'browse-list', list: 'followers', of: 'studio.lumen', done: 120, total: null }, "Scrolling @studio.lumen's followers · 120"],
  [{ op: 'read-list', list: 'followers', of: 'studio.lumen', done: 120, total: 250 }, "Reading @studio.lumen's followers · 120 of 250"],
  [{ op: 'read-list', list: 'followers', of: null, done: 1_200, total: null }, 'Reading your followers · 1,200'],
  [{ op: 'read-list', list: 'following', of: null, done: 4, total: 10 }, 'Reading your following · 4 of 10'],
  [{ op: 'visit-profiles', done: 3, total: 20 }, 'Looking at profiles · 3 of 20'],
  [{ op: 'visit-profile', username: 'bob', purpose: 'check-back' }, 'Checking whether @bob follows you back'],
  [{ op: 'visit-profile', username: 'bob', purpose: 'verify' }, 'Double-checking @bob before acting'],
  [{ op: 'visit-profile', username: 'bob', purpose: 'settle' }, 'Confirming what happened with @bob'],
  [{ op: 'visit-profile', username: 'bob', purpose: 'seed' }, 'Checking @bob'],
  [{ op: 'check-notifications' }, 'Checking your notifications'],
  [{ op: 'open-own-profile' }, 'Opening your profile'],
  [{ op: 'confirm-account' }, 'Confirming your account'],
];

test.each(SENTENCES)('liveOpText says one plain sentence: %j', (op, sentence) => {
  expect(liveOpText(op)).toBe(sentence);
});

test.each(SENTENCES)('the veil shows the same sentence, its count beside the label: %j', (op, sentence) => {
  for (const kind of ['api', 'page'] as const) {
    const veil = toVeilInfo({ kind, op });
    const p = liveOpProgress(op);
    const count = veil.count === undefined ? '' : veil.total === undefined
      ? ` · ${veil.count.toLocaleString('en-US')}`
      : ` · ${veil.count.toLocaleString('en-US')} of ${veil.total.toLocaleString('en-US')}`;
    expect(`${veil.label}${count}`).toBe(sentence);
    expect(veil.kind).toBe(kind);
    expect(veil.label).toBe(liveOpLead(op));
    expect(veil.detail).toBeUndefined();
    if (p === null) expect(veil.count).toBeUndefined();
  }
});

test('a list read keeps one veil label while its count moves (the veil phase timer keys on it)', () => {
  const at = (done: number): ActivityInfo => ({ kind: 'api', op: { op: 'read-list', list: 'followers', of: null, done, total: null } });
  expect(toVeilInfo(at(0)).label).toBe(toVeilInfo(at(400)).label);
  expect(toVeilInfo(at(400))).toEqual({ kind: 'api', label: 'Reading your followers', count: 400 });
});

test('no sentence uses a banned word or a raw key', () => {
  for (const [op] of SENTENCES) {
    expect(liveOpText(op)).not.toMatch(/bot|human|emulat|stealth|mimic|spoof|detect|natural|undefined|null|[a-z]+-[a-z]+-/i);
  }
});
