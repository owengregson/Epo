import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccountSuggestion } from '@/shared/settings-facts';

export interface Suggestions {
  readonly rows: readonly AccountSuggestion[];
  /** `unavailable`: the store could not answer (closed, or the read failed) — the field still takes typing. */
  readonly state: 'idle' | 'loading' | 'ok' | 'unavailable';
}

const IDLE: Suggestions = { rows: [], state: 'idle' };

/**
 * Account suggestions for the protection field (spec §7.8): store-only, so no Instagram traffic; the
 * newest query wins and an older answer is dropped. An empty query asks nothing.
 */
export function useSuggest(query: string, scope: 'following' | 'known' = 'following'): Suggestions {
  const [out, setOut] = useState<Suggestions>(IDLE);
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim().replace(/^@+/, '');
    seq.current += 1;
    const mine = seq.current;
    if (q === '') {
      setOut(IDLE);
      return;
    }
    setOut((prev) => ({ rows: prev.rows, state: 'loading' }));
    window.epo.suggestAccounts(q, scope).then(
      (r) => {
        if (mine !== seq.current) return;
        setOut(r.kind === 'ok' ? { rows: r.rows, state: 'ok' } : { rows: [], state: 'unavailable' });
      },
      () => {
        if (mine === seq.current) setOut({ rows: [], state: 'unavailable' });
      },
    );
  }, [query, scope]);
  return out;
}
