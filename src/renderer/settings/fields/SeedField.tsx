/**
 * The starting account (spec §13): the status line comes from the store-derived facts (`settingsFacts.seed`),
 * so opening Settings never checks anything. A live check runs only on explicit intent — committing a
 * different handle, or Check now / Try again. Only an evidence-backed "doesn't exist" turns the field red;
 * busy, offline, queued and unreadable checks are never verdicts.
 */
import type { JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { useNow } from '@/renderer/app/clock';
import { Icon } from '@/renderer/ui/Icon';
import type { SeedCheckResult } from '@/shared/seed-check';
import type { SeedStatus } from '@/shared/settings-facts';
import { AUDIENCE_COPY } from '../copy/choices';
import { SEED_COPY, SEED_QUEUED_COPY } from '../copy/fields';
import { agoLabel, compact, fill } from '../format';
import type { StageApi } from '../stage-api';
import { ControlError } from './controls';

const KEY = 'seed';
type Tone = 'ok' | 'info' | 'warn' | 'error';
/** The last explicit check: still running, or its typed answer. */
type Outcome = 'running' | SeedCheckResult;

/** The handle as the document stores it: trimmed, without a leading "@". */
export const cleanHandle = (raw: string): string => raw.trim().replace(/^@+/, '');

/** A check's answer as the status it implies, so it reads exactly like the facts would. */
function asStatus(r: SeedCheckResult, u: string): SeedStatus | null {
  switch (r.kind) {
    case 'ok':
      return { kind: 'seen', handle: u, pk: r.pk, currentUsername: u, observedAt: r.observedAt, followers: r.followers,
        isPrivate: r.isPrivate, followersVisible: r.followersVisible };
    case 'not-found':
      return { kind: 'gone', handle: u, at: r.observedAt, evidence: r.evidence };
    case 'queued':
      return { kind: 'queued', handle: u, why: r.why };
    default:
      return null;
  }
}

interface Line {
  readonly tone: Tone;
  readonly text: string;
  readonly action?: { readonly label: string; run(): void };
  readonly busy?: boolean;
}

function factsLine(st: SeedStatus, u: string, now: number, check: () => void): Line | null {
  switch (st.kind) {
    case 'none':
      return null;
    case 'loading':
      return { tone: 'info', text: fill(SEED_COPY.loading, { u }) };
    case 'unseen':
      return { tone: 'info', text: fill(SEED_COPY.unseen, { u }), action: { label: SEED_COPY.checkNow, run: check } };
    case 'checking':
      return { tone: 'info', text: fill(SEED_COPY.checking, { u }), busy: true };
    case 'queued':
      return { tone: 'info', text: fill(SEED_QUEUED_COPY[st.why], { u }) };
    case 'gone':
      return st.evidence === 'profile-absent'
        ? { tone: 'error', text: fill(SEED_COPY.absent, { u }) }
        : { tone: 'warn', text: fill(SEED_COPY.pageText, { u }), action: { label: SEED_COPY.checkAgain, run: check } };
    case 'seen': {
      if (st.isPrivate === true && st.followersVisible === false) return { tone: 'warn', text: fill(SEED_COPY.privateHidden, { u }) };
      const visibility = st.isPrivate === null ? '' : st.isPrivate ? SEED_COPY.private : SEED_COPY.public;
      const parts = [`@${st.currentUsername}`, st.followers === null ? null : `${compact(st.followers)} followers`,
        visibility || null, `checked ${agoLabel(st.observedAt, now)}`];
      return { tone: 'ok', text: parts.filter((p) => p !== null).join(' · ') };
    }
  }
}

export function SeedField({ s }: { s: StageApi }): JSX.Element {
  const id = useId();
  const now = useNow('minute');
  const saved = s.c.value<string>(KEY, s.view.seed);
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<{ handle: string; kind: Outcome } | null>(null);
  const [checkAfterSave, setCheckAfterSave] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [restartFailed, setRestartFailed] = useState<string | null>(null);
  /** Esc reverts: the blur that follows must not commit what was typed. */
  const reverted = useRef(false);

  const check = (handle: string): void => {
    setOutcome({ handle, kind: 'running' });
    window.epo.checkSeed(handle).then(
      (r) => setOutcome({ handle, kind: r }),
      () => setOutcome({ handle, kind: { kind: 'unreadable', why: 'error' } }),
    );
  };
  // Committing a different handle is explicit intent: check it once its save has landed.
  useEffect(() => {
    if (checkAfterSave !== null && s.view.seed === checkAfterSave) {
      setCheckAfterSave(null);
      check(checkAfterSave);
    }
  }, [s.view.seed, checkAfterSave]);

  const save = (handle: string): void => {
    setChoice(null);
    setRestartFailed(null);
    s.send(KEY, [{ op: 'seed', handle }], handle);
    setCheckAfterSave(handle === '' ? null : handle);
  };
  const working = s.status?.basis === 'built' && (s.status.chainIndex !== null || s.status.currentTargetPk !== null);
  const commit = (raw: string): void => {
    setEditing(false);
    const handle = cleanHandle(raw);
    if (handle === s.view.seed) return;
    if (handle !== '' && s.view.seed !== '' && working) setChoice(handle);
    else save(handle);
  };
  const restart = (handle: string): void => {
    setChoice(null);
    window.epo.restartFromSeed(handle).catch(() => setRestartFailed(handle));
  };

  const u = cleanHandle(saved);
  const facts = s.facts;
  const st: SeedStatus = facts === null || !facts.built ? (u === '' ? { kind: 'none' } : { kind: 'loading' }) : facts.seed;
  const factsSettled = st.kind === 'seen' || st.kind === 'gone' || st.kind === 'queued' || st.kind === 'checking';
  const mine = outcome !== null && outcome.handle === u && !factsSettled ? outcome.kind : null;
  const again = (): void => check(u);
  const line: Line | null =
    mine === 'running' ? { tone: 'info', text: fill(SEED_COPY.checking, { u }), busy: true }
    : mine?.kind === 'unreadable' ? { tone: 'warn', text: fill(SEED_COPY.unreadable, { u }), action: { label: SEED_COPY.tryAgain, run: again } }
    : mine?.kind === 'invalid-handle' ? { tone: 'warn', text: fill(SEED_COPY.invalid, { u }) }
    : u === '' ? { tone: 'info', text: SEED_COPY.needed }
    : factsLine((mine === null ? null : asStatus(mine, u)) ?? st, u, now, again);
  const red = line?.tone === 'error';

  return (
    <div class="set-field" data-row="seed" data-tour="seed">
      <label class="set-field__label" for={`${id}-in`}>
        {SEED_COPY.label}
      </label>
      <span class="set-field__help" id={`${id}-help`}>
        {AUDIENCE_COPY.seedHelp}
      </span>
      <input
        id={`${id}-in`}
        class={red ? 'set-input is-invalid' : 'set-input'}
        type="text"
        data-focus="seed"
        value={editing ? draft : saved}
        placeholder={SEED_COPY.placeholder}
        spellcheck={false}
        autocomplete="off"
        aria-invalid={red}
        aria-describedby={`${id}-help ${id}-line`}
        onFocus={() => {
          setDraft(saved);
          setEditing(true);
        }}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={(e) => {
          if (reverted.current) {
            reverted.current = false;
            setEditing(false);
          } else commit((e.currentTarget as HTMLInputElement).value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            reverted.current = true;
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      <p class={line ? `set-seed set-seed--${line.tone}` : 'set-seed'} id={`${id}-line`} role="status" aria-live="polite">
        {line === null ? null : (
          <>
            {line.busy ? <Icon name="spinner" spin /> : line.tone === 'ok' ? <Icon name="check" /> : null}
            <span>{line.text}</span>
            {line.action ? (
              <button type="button" class="link-btn" onClick={line.action.run}>
                {line.action.label}
              </button>
            ) : null}
          </>
        )}
      </p>
      {choice !== null ? (
        <div class="set-inline-choice" role="group" aria-label={fill(SEED_COPY.startOver, { u: choice })}>
          <p>{fill(SEED_COPY.changeLine, { old: s.view.seed, u: choice })}</p>
          <div class="set-inline-choice__actions">
            <button type="button" class="set-btn set-btn--primary" onClick={() => restart(choice)}>
              {fill(SEED_COPY.startOver, { u: choice })}
            </button>
            <button type="button" class="set-btn" onClick={() => save(choice)}>
              {SEED_COPY.saveLater}
            </button>
          </div>
        </div>
      ) : null}
      {restartFailed !== null ? (
        <p class="set-err" role="alert">
          {fill(SEED_COPY.restartFailed, { u: restartFailed })}
        </p>
      ) : null}
      <ControlError s={s} k={KEY} />
    </div>
  );
}
