/**
 * The kernel's catalog as main serves it (`settingsBasis`, spec §6.5): every tier-1 entry with its value,
 * unit, kind, source and guard line, grouped by kind. Fetched once when a section that shows it opens;
 * values arrive formatted ('[a, b]', '∞', 'true'). Read only.
 */
import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BasisRow } from '@/shared/settings-view';
import { BASIS_COPY } from '../copy/advanced';
import { fill } from '../format';

export type BasisLoad = { readonly kind: 'loading' } | { readonly kind: 'ok'; readonly rows: readonly BasisRow[] } | { readonly kind: 'unavailable' };

let cache: Promise<BasisLoad> | null = null;

/** Test seam: forget the fetched catalog. */
export function resetBasisCache(): void {
  cache = null;
}

/** The catalog, fetched once per app session (it changes only with a new build). */
export function useBasis(): { load: BasisLoad; retry(): void } {
  const [load, setLoad] = useState<BasisLoad>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    cache ??= window.epo.settingsBasis().then(
      (r): BasisLoad => (r.kind === 'ok' ? { kind: 'ok', rows: r.rows } : { kind: 'unavailable' }),
      (): BasisLoad => ({ kind: 'unavailable' }),
    );
    void cache.then((r) => {
      if (r.kind === 'unavailable') cache = null;
      if (alive) setLoad(r);
    });
    return () => {
      alive = false;
    };
  }, [tick]);
  return { load, retry: () => setTick((t) => t + 1) };
}

export const valueText = (r: BasisRow): string => (r.unit === null ? String(r.value) : `${r.value} ${r.unit}`);

function Group({ group, rows }: { group: BasisRow['group']; rows: readonly BasisRow[] }): JSX.Element {
  return (
    <details class="set-basis__group" open={rows.length <= 12}>
      <summary>
        {BASIS_COPY.groups[group]} <span class="num">· {fill(BASIS_COPY.count, { n: rows.length })}</span>
      </summary>
      <table class="set-plan__table set-basis__table">
        <thead>
          <tr>
            {[BASIS_COPY.name, BASIS_COPY.value, BASIS_COPY.tier, BASIS_COPY.source, BASIS_COPY.why].map((h) => <th key={h}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label={BASIS_COPY.name}><code>{r.id}</code></td>
              <td data-label={BASIS_COPY.value} class="num">{valueText(r)}</td>
              <td data-label={BASIS_COPY.tier}>{r.tier ?? '—'}</td>
              <td data-label={BASIS_COPY.source}>{[r.src, r.rev].filter((x) => x !== null).join(' · ') || r.module}</td>
              <td data-label={BASIS_COPY.why}>{r.guard ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const ORDER: readonly BasisRow['group'][] = ['fundamental', 'policy', 'bound', 'derived', 'registry', 'motion'];

/** Rows grouped by kind, with a filter over names, modules and guard lines (off for a short, fixed subset). */
export function BasisTable({ only, filter = true }: { only?: (r: BasisRow) => boolean; filter?: boolean }): JSX.Element {
  const { load, retry } = useBasis();
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    if (load.kind !== 'ok') return [];
    const needle = q.trim().toLowerCase();
    return load.rows.filter((r) => (only === undefined || only(r))
      && (needle === '' || `${r.id} ${r.module} ${r.guard ?? ''}`.toLowerCase().includes(needle)));
  }, [load, q, only]);
  if (load.kind === 'loading') return <p class="set-sec__hint">{BASIS_COPY.loading}</p>;
  if (load.kind === 'unavailable') {
    return (
      <p class="set-sec__hint">
        {BASIS_COPY.unavailable}{' '}
        <button type="button" class="link-btn" onClick={retry}>{BASIS_COPY.retry}</button>
      </p>
    );
  }
  return (
    <div class="set-basis">
      {filter ? (
        <input class="set-input" type="search" placeholder={BASIS_COPY.filter} aria-label={BASIS_COPY.filter} value={q}
          onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
      ) : null}
      {rows.length === 0 ? <p class="set-sec__hint">{fill(BASIS_COPY.none, { q })}</p> : null}
      {ORDER.map((g) => {
        const mine = rows.filter((r) => r.group === g);
        return mine.length === 0 ? null : <Group key={g} group={g} rows={mine} />;
      })}
    </div>
  );
}
