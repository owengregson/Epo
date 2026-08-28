/**
 * Toast stack cap — the pure step behind useToasts.push. The contract: a
 * failure burst can never stack past TOAST_CAP simultaneous toasts (the CSS
 * dock would clip the overflow unreadable and undismissable); the OLDEST
 * toasts drop first and are reported so their auto-dismiss timers get cleared.
 */
import { appendCapped, type Toast, TOAST_CAP } from '@/renderer/hooks/useToasts';

const toast = (id: number): Toast => ({ id, kind: 'error', message: `failure ${id}` });

describe('appendCapped', () => {
  it('appends without dropping while under the cap', () => {
    const prev = [toast(1), toast(2)];
    const { toasts, dropped } = appendCapped(prev, toast(3));
    expect(toasts.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(dropped).toEqual([]);
  });

  it('drops the oldest once the cap is exceeded', () => {
    let list: Toast[] = [];
    for (let id = 1; id <= TOAST_CAP; id++) {
      list = appendCapped(list, toast(id)).toasts;
    }
    const { toasts, dropped } = appendCapped(list, toast(TOAST_CAP + 1));
    expect(toasts).toHaveLength(TOAST_CAP);
    expect(toasts.map((t) => t.id)).toEqual(Array.from({ length: TOAST_CAP }, (_, i) => i + 2));
    expect(dropped.map((t) => t.id)).toEqual([1]);
  });

  it('reports every dropped toast when the incoming list is already oversized', () => {
    const prev = Array.from({ length: 8 }, (_, i) => toast(i + 1));
    const { toasts, dropped } = appendCapped(prev, toast(9), 5);
    expect(toasts.map((t) => t.id)).toEqual([5, 6, 7, 8, 9]);
    expect(dropped.map((t) => t.id)).toEqual([1, 2, 3, 4]);
  });

  it('never mutates the previous list', () => {
    const prev = Array.from({ length: TOAST_CAP }, (_, i) => toast(i + 1));
    const snapshot = prev.slice();
    appendCapped(prev, toast(99));
    expect(prev).toEqual(snapshot);
  });
});
