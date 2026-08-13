import { useCallback, useState } from 'preact/hooks';

export interface ConfirmOptions {
  title: string;
  body: string;
  /** Label for the confirming action. */
  confirm: string;
  /** Label for the dismiss action (default "Cancel"). */
  dismiss?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

export interface ConfirmState extends ConfirmOptions {
  open: boolean;
}

export interface ConfirmController {
  state: ConfirmState;
  /** Open the modal; resolves true on confirm, false on dismiss. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Resolve and close (used by the host's buttons/scrim/escape). */
  close(result: boolean): void;
}

const CLOSED: ConfirmState = { open: false, title: '', body: '', confirm: '' };

/**
 * Promise-based confirmation modal controller. `confirm({...})` returns a promise
 * that resolves when the user chooses; the shell renders one `ConfirmHost` bound
 * to `state`. Cancel-session and Restart-from-seed both reuse this single modal.
 */
export function useConfirm(): ConfirmController {
  const [state, setState] = useState<ConfirmState>(CLOSED);
  const [, setResolver] = useState<{ fn: (v: boolean) => void } | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setResolver({ fn: resolve });
      setState({ ...options, open: true });
    });
  }, []);

  const close = useCallback(
    (result: boolean): void => {
      setResolver((r) => {
        r?.fn(result);
        return null;
      });
      setState((s) => ({ ...s, open: false }));
    },
    [],
  );

  return { state, confirm, close };
}
