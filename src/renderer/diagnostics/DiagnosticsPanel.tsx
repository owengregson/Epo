/**
 * Diagnostics (Settings › Advanced; spec §12.9, owner Q30): the raw log, streamed only while this panel is
 * open — filter by level, search, pause, copy, open the log folder — what the Instagram page is used for
 * right now, and the runtime's recent incidents in plain words (their codes beside them).
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { activitySignal } from '@/renderer/app/live-signals';
import { statusSignal, useShell } from '@/renderer/app/shell-context';
import { DIAGNOSTICS_COPY as C, type LevelFilter, lineText, passes } from '@/renderer/diagnostics/diagnostics-copy';
import { useLogTail } from '@/renderer/diagnostics/useLogTail';
import { attentionSentence } from '@/renderer/sidebar/copy/attention-copy';
import { weekdayTime } from '@/renderer/sidebar/format';
import { Icon } from '@/renderer/ui/Icon';
import { classifyBlock } from '@/shared/attention';
import { liveOpText } from '@/shared/live-op';
import type { LogEntry } from '@/shared/log-entry';

const LEVELS = Object.keys(C.levels) as LevelFilter[];

const SECONDS = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
/** A log line's time, to the second ("9:40:12 PM"). */
const lineTime = (at: number): string => SECONDS.format(at);

function Incidents(): JSX.Element {
  const incidents = [...(statusSignal.value?.runtime?.incidents ?? [])].reverse();
  return (
    <section class="diag-incidents" aria-label={C.incidents}>
      <h4>{C.incidents}</h4>
      {incidents.length === 0 ? (
        <p class="diag-muted">{C.noIncidents}</p>
      ) : (
        <ul>
          {incidents.map((i) => {
            const a = classifyBlock(i.reason);
            const words = a.key === 'unknown' ? null : attentionSentence(a, { maxAttempts: null, unconfirmed: null });
            return (
              <li key={`${i.at}:${i.reason}`}>
                <time class="num">{weekdayTime(i.at)}</time>
                <span>{words ?? i.reason}</span>
                <code class="diag-muted">{i.detail === undefined ? i.reason : `${i.reason} · ${i.detail}`}</code>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PageNow(): JSX.Element {
  const tab = activitySignal.value;
  const op = tab?.activity?.info.op ?? null;
  const holds = tab?.holds ?? [];
  const now = op !== null ? liveOpText(op) : holds.length > 0 ? holds.join(', ') : C.pageFree;
  return (
    <p class="diag-now">
      <span class="diag-muted">{C.pageNow}</span> {now}
    </p>
  );
}

export function DiagnosticsPanel(): JSX.Element {
  const { entries, failed } = useLogTail();
  const { toast } = useShell();
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const [frozen, setFrozen] = useState<readonly LogEntry[] | null>(null);
  const shown = (frozen ?? entries).filter((e) => passes(e, level, query));
  const copy = (): void => {
    navigator.clipboard.writeText(shown.map(lineText).join('\n')).then(
      () => toast('success', C.copied),
      () => toast('error', C.copyFailed),
    );
  };
  return (
    <div class="diag" data-section="diagnostics">
      <p class="diag-lead">{C.lead}</p>
      <div class="diag-bar">
        <div class="diag-filters">
          <div class="diag-levels" role="group" aria-label="Level">
            {LEVELS.map((l) => (
              <button key={l} type="button" class={l === level ? 'chip active' : 'chip'} aria-pressed={l === level} onClick={() => setLevel(l)}>
                {C.levels[l]}
              </button>
            ))}
          </div>
          <input class="diag-search" type="search" placeholder={C.search} aria-label={C.search} value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="diag-actions" role="group" aria-label="Log actions">
          <button type="button" class="tbtn" aria-pressed={frozen !== null} onClick={() => setFrozen((f) => (f === null ? entries : null))}>
            <Icon name={frozen === null ? 'pause' : 'play'} /> {frozen === null ? C.pause : C.resume}
          </button>
          <button type="button" class="tbtn" onClick={copy}>{C.copy}</button>
          <button type="button" class="tbtn" onClick={() => void window.epo.openLogFolder()}>{C.openFolder}</button>
        </div>
      </div>
      <PageNow />
      {frozen !== null ? <p class="diag-muted">{C.paused}</p> : null}
      {failed ? <p class="diag-muted">{C.unreadable}</p> : null}
      <ol class="diag-log" aria-live="off">
        {shown.length === 0 ? (
          <li class="diag-muted">{entries.length === 0 ? C.empty : C.noMatch}</li>
        ) : (
          shown.map((e, i) => (
            <li key={`${e.at}:${i}`} data-level={e.level}>
              <time class="num">{lineTime(e.at)}</time>
              <span class="diag-level">{e.level}</span>
              <span class="diag-msg">{e.message}</span>
            </li>
          ))
        )}
      </ol>
      <Incidents />
    </div>
  );
}
