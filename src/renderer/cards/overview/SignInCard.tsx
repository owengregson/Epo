/** @jsx h */
import { h } from 'preact';
import { Button } from '@/renderer/ui/Button';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';

export interface SignInCardProps {
  /** The shell's in-flight control name (`'login'` while the tab is opening). */
  pending: string | null;
  /** Opens Instagram in the embedded tab so the user can log in. */
  onLogin(): void;
}

/**
 * The logged-out gate. Shown first on the Overview whenever the persisted IG
 * session is missing; the rest of the console stays visible (read-only) below.
 */
export function SignInCard({ pending, onLogin }: SignInCardProps): h.JSX.Element {
  const opening = pending === 'login';
  return (
    <Card raised index={0}>
      <CardHeader icon="user-lock">Not signed in</CardHeader>
      <CardBody>
        <div class="hint">
          Open Instagram in the tab on the right and log in. The engine builds itself the moment
          your session is live.
        </div>
        <Button
          wide
          icon="arrow-right-from-bracket"
          iconSpin={opening}
          disabled={opening}
          onClick={() => onLogin()}
        >
          {opening ? 'Opening…' : 'Open Instagram'}
        </Button>
      </CardBody>
    </Card>
  );
}
