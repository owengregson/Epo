/**
 * Currently kept (spec §7.8, Advanced → Protection): the accounts Epo keeps instead of unfollowing, a page
 * at a time from `keptList`, with why, what matched, since when and when Epo looks again. A page that main
 * cannot serve says so; it never shows an empty table in its place.
 */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useNow } from '@/renderer/app/clock';
import type { KeptPageResult } from '@/shared/settings-facts';
import { KEPT_COPY } from '../copy/advanced';
import { agoLabel, fill, timeLabel } from '../format';

type Load = { kind: 'loading' } | KeptPageResult | { kind: 'failed' };

/** `refresh` changes when the kept count moves, so the page re-reads with the facts. */
export function KeptTable({ refresh }: { refresh: number }): JSX.Element {
  const now = useNow('minute');
  const [page, setPage] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [size, setSize] = useState(0);
  useEffect(() => {
    let alive = true;
    window.epo.keptList(page).then(
      (r) => {
        if (!alive) return;
        setLoad(r);
        if (r.kind === 'ok') setSize((s) => Math.max(s, r.rows.length));
      },
      () => {
        if (alive) setLoad({ kind: 'failed' });
      },
    );
    return () => {
      alive = false;
    };
  }, [page, refresh]);

  if (load.kind === 'loading') return <p class="set-sec__hint">{KEPT_COPY.loading}</p>;
  if (load.kind !== 'ok') return <p class="set-sec__hint">{KEPT_COPY.unavailable}</p>;
  if (load.total === 0) return <p class="set-sec__hint">{KEPT_COPY.empty}</p>;
  const from = page * size + 1;
  const to = page * size + load.rows.length;
  const when = (at: number): string => (at > now ? timeLabel(at) : agoLabel(at, now));
  return (
    <div class="set-kept">
      <table class="set-plan__table set-kept__table num">
        <thead>
          <tr>
            {[KEPT_COPY.account, KEPT_COPY.why, KEPT_COPY.match, KEPT_COPY.since, KEPT_COPY.next].map((h) => <th key={h}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {load.rows.map((r) => (
            <tr key={r.pk}>
              <td data-label={KEPT_COPY.account}>{r.username === null ? KEPT_COPY.never : `@${r.username}`}</td>
              <td data-label={KEPT_COPY.why}>{KEPT_COPY.reasons[r.reason] ?? r.reason}</td>
              <td data-label={KEPT_COPY.match}>{r.match ?? KEPT_COPY.never}</td>
              <td data-label={KEPT_COPY.since}>{r.keptAt > 0 ? agoLabel(r.keptAt, now) : KEPT_COPY.never}</td>
              <td data-label={KEPT_COPY.next}>{r.recheckAt === null ? KEPT_COPY.never : when(r.recheckAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="set-kept__pager">
        <span class="num">{fill(KEPT_COPY.range, { from, to, total: load.total })}</span>
        <button type="button" class="set-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
          {KEPT_COPY.previous}
        </button>
        <button type="button" class="set-btn" disabled={to >= load.total} onClick={() => setPage(page + 1)}>
          {KEPT_COPY.nextPage}
        </button>
      </div>
    </div>
  );
}
