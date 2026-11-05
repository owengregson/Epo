import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { peopleTargetSignal, statusSignal } from '@/renderer/app/shell-context';
import { LEGEND_LABELS } from '@/renderer/graph/palette';
import { commas } from '@/renderer/lib/format';
import { Button } from '@/renderer/ui/Button';
import { GRAPH_NODE_STATUSES, type GraphSnapshot } from '@/types';

/** A feed selection reads the current graph by pk, including people outside the visible queue page. */
export function SelectedPerson({ active }: { active: boolean }): JSX.Element | null {
  const person = peopleTargetSignal.value;
  const status = statusSignal.value;
  const [read, setRead] = useState<{ person: typeof person; snapshot: GraphSnapshot | null } | null>(null);
  const [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!active || person === null) return;
    let alive = true;
    window.epo.graphSnapshot().then(
      (snapshot) => { if (alive) setRead({ person, snapshot: snapshot !== null && 'unavailable' in snapshot ? null : snapshot }); },
      () => { if (alive) setRead({ person, snapshot: null }); },
    );
    return () => { alive = false; };
  }, [active, person, status, retry]);
  useEffect(() => {
    if (active && person !== null) heading.current?.focus();
  }, [active, person]);
  if (person === null) return null;
  const loaded = read?.person === person;
  const snapshot = loaded ? read.snapshot : null;
  const index = snapshot?.pks.indexOf(person.pk) ?? -1;
  const hub = snapshot?.hubs.find((h) => h.pk === person.pk);
  const username = index >= 0 ? snapshot?.usernames[index] : hub?.username;
  const label = username ?? person.username;
  const state = snapshot && index >= 0 ? GRAPH_NODE_STATUSES[snapshot.statuses[index]] : undefined;
  const followers = snapshot && index >= 0 ? snapshot.followers[index] : -1;
  return (
    <section class="people-panel" aria-labelledby="selected-person" data-person-pk={person.pk}>
      <div class="people-panel__head">
        <h2 id="selected-person" ref={heading} tabIndex={-1}>{label === null ? 'Selected account' : `@${label}`}</h2>
        <Button onClick={() => { peopleTargetSignal.value = null; }}>Close</Button>
      </div>
      {!loaded ? <p>Loading stored details…</p> : snapshot === null ? (
        <><p>Epo can’t read this person’s stored details right now.</p><Button onClick={() => setRetry((n) => n + 1)}>Try again</Button></>
      ) : index < 0 && hub === undefined ? <p>This person is no longer in the current graph. Their earlier activity remains in the feed.</p> : (
        <>
          <p>{state === undefined ? (hub?.kind === 'self' ? 'Your account' : 'Source account') : LEGEND_LABELS[state]}</p>
          {followers >= 0 ? <p>{commas(followers)} followers</p> : null}
          {username != null && person.username !== null && username !== person.username ? <p>Previously @{person.username}</p> : null}
        </>
      )}
    </section>
  );
}
