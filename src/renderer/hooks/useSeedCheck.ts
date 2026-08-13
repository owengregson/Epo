import { useEffect, useRef, useState } from 'preact/hooks';

export type SeedStatus = 'idle' | 'checking' | 'valid' | 'invalid';

export interface SeedCheckController {
  /** Current field text (with any leading "@"). */
  value: string;
  /** Update the field; debounces a real verification 1s after the last edit. */
  setValue(next: string): void;
  status: SeedStatus;
  /** Human error/context message when invalid (or a private-account note). */
  message?: string;
  /** True only for a verified, harvestable seed. */
  valid: boolean;
}

const DEBOUNCE_MS = 1000;

function reasonMessage(reason: string | undefined, name: string): string {
  switch (reason) {
    case 'not-found':
      return `Couldn’t verify @${name} — account not found.`;
    case 'private':
      return `@${name} is private — you must follow it before its followers are visible.`;
    case 'not-logged-in':
      return 'Log in to Instagram before verifying a seed.';
    case 'blocked':
      return 'Instagram is rate-limiting — try again shortly.';
    case 'budget':
      return 'Request budget exhausted — try again shortly.';
    default:
      return `Couldn’t verify @${name} — account not found, or its followers aren’t visible.`;
  }
}

/**
 * Live seed-username validity check. Debounces edits, then calls `seed:check`
 * (which confirms the account exists and its followers are viewable) and reflects
 * checking / valid / invalid. Stale in-flight checks are discarded.
 */
export function useSeedCheck(initial = ''): SeedCheckController {
  const [value, setValueState] = useState(initial);
  const [status, setStatus] = useState<SeedStatus>('idle');
  const [message, setMessage] = useState<string | undefined>();
  const req = useRef(0);
  const timer = useRef<number | undefined>();

  const run = (clean: string): void => {
    const id = req.current;
    setStatus('checking');
    window.epo
      .checkSeed(clean)
      .then((r) => {
        if (id !== req.current) return; // superseded
        if (r.ok && r.exists && r.followersVisible) {
          setStatus('valid');
          setMessage(undefined);
        } else if (r.ok && r.exists && !r.followersVisible) {
          setStatus('invalid');
          setMessage(reasonMessage('private', clean));
        } else {
          setStatus('invalid');
          setMessage(reasonMessage(r.reason, clean));
        }
      })
      .catch(() => {
        if (id === req.current) {
          setStatus('invalid');
          setMessage('Verification failed — please try again.');
        }
      });
  };

  const schedule = (raw: string): void => {
    req.current++;
    if (timer.current) window.clearTimeout(timer.current);
    const clean = raw.trim().replace(/^@/, '');
    if (!clean) {
      setStatus('idle');
      setMessage(undefined);
      return;
    }
    setStatus('checking');
    const id = req.current;
    timer.current = window.setTimeout(() => {
      if (id === req.current) run(clean);
    }, DEBOUNCE_MS);
  };

  const setValue = (next: string): void => {
    setValueState(next);
    schedule(next);
  };

  // Verify the initial seed once on mount (mockup: seedFetch on load).
  useEffect(() => {
    const clean = initial.trim().replace(/^@/, '');
    if (clean) run(clean);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { value, setValue, status, message, valid: status === 'valid' };
}
