/**
 * Now (spec §12.2): the column's one raised surface — the ring, the posture word with its indicator pills,
 * what is happening (the live-op sentence, else the posture's own), when the next thing happens with a
 * "Why?", progress when known, the controls, and a reason only when there is something to explain.
 */
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useNow } from '@/renderer/app/clock';
import { activitySignal, pendingControlSignal } from '@/renderer/app/live-signals';
import { usePopover } from '@/renderer/app/PopoverHost';
import { pruneSignal, statusSignal } from '@/renderer/app/shell-context';
import { DUR } from '@/renderer/design/motion-scale';
import { play } from '@/renderer/lib/play';
import { attentionCode, attentionSentence, SCHEDULES_WAIT } from '@/renderer/sidebar/copy/attention-copy';
import { catchUpChecklist, explainText } from '@/renderer/sidebar/copy/explain-copy';
import { headlineOf, nextLineOf, PILL, RING_GLYPH, sentenceOf } from '@/renderer/sidebar/copy/posture-copy';
import { postureSignal } from '@/renderer/sidebar/posture-signal';
import { clearReason, reasonSignal } from '@/renderer/sidebar/reason-line';
import { partsOf } from '@/renderer/sidebar/Said';
import { StatusRing } from '@/renderer/sidebar/StatusRing';
import { TransportRow } from '@/renderer/sidebar/TransportRow';
import { Icon } from '@/renderer/ui/Icon';
import { liveOpProgress, liveOpText } from '@/shared/live-op';
import type { Posture } from '@/shared/posture';

/** The now line as plain inline words, its people in bold: one line that ellipsizes as a whole. */
function NowWords({ text }: { text: string }): JSX.Element {
  return (
    <>
      {partsOf(text).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <b key={`${i}:${part.person.username}`} class="sb-now__who">
            @{part.person.username}
          </b>
        ),
      )}
    </>
  );
}

/** Kinds whose now line may name the step in flight. */
const NARRATES = new Set<Posture['kind']>(['working', 'cleaning-up', 'catching-up', 'starting', 'taking-a-break']);

/** Seconds tick only while a visible "m:ss" exists (a deadline under an hour away). */
const HOUR_MS = 60 * 60 * 1000;

function WhyButton({ posture }: { posture: Posture }): JSX.Element | null {
  const popover = usePopover();
  const topic = posture.explain;
  if (topic === null) return null;
  const s = statusSignal.peek();
  const open = (e: MouseEvent): void => {
    const plan = s?.plan ?? null;
    const text = explainText(topic, {
      sessions: plan === null ? null : plan.sessions.length,
      visitsAt: s?.parkedUntil ?? null,
      attempt: s?.recovery ? { n: s.recovery.attempt, max: s.recovery.maxAttempts } : null,
      lateOrLight: plan !== null && plan.totals.planned === 0 && (plan.day.lateStart || plan.day.light),
    });
    const steps = topic === 'catching-up' && s?.catchUp ? catchUpChecklist(s.catchUp.steps, s.catchUp.since) : [];
    popover.open({
      anchor: e.currentTarget as Element,
      labelledBy: 'sb-why-title',
      content: () => (
        <div class="sb-why">
          <h3 id="sb-why-title">Why?</h3>
          <p>{text}</p>
          {steps.length === 0 ? null : (
            <ul class="sb-why__steps">
              {steps.map((step) => (
                <li key={step.label} class={step.done ? 'is-done' : step.now ? 'is-now' : undefined}>
                  <span class="sb-why__tick">{step.done ? <Icon name="check" /> : null}</span>
                  {step.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    });
  };
  return (
    <button type="button" class="sb-link sb-why-link" onClick={open}>
      Why?
    </button>
  );
}

/** The reason line: a refusal of the person's own command, else the attention's follow-up. */
function reasonOf(p: Posture): string | null {
  const reason = reasonSignal.value;
  if (reason !== null) return reason.text;
  const s = statusSignal.value;
  if (p.kind === 'needs-attention' && p.attention !== null) return attentionCode(p.attention) ?? SCHEDULES_WAIT;
  if (p.attention?.key === 'actions-unconfirmed') {
    return attentionSentence(p.attention, { maxAttempts: null, unconfirmed: s?.actionsUnconfirmed ?? null });
  }
  if (s?.boost?.state === 'paused' && (p.kind === 'stopped' || p.kind === 'needs-seed')) return 'Press Start to use Boost.';
  return null;
}

export function NowPanel(): JSX.Element {
  const p = postureSignal.value;
  const status = statusSignal.value;
  const prune = pruneSignal.value;
  const op = activitySignal.value?.activity?.info.op ?? null;
  const pending = pendingControlSignal.value;
  const reason = reasonSignal.value;
  const to = p.countdown?.to ?? null;
  const now = useNow('second', to !== null && to - Date.now() < HOUR_MS);
  const card = useRef<HTMLDivElement>(null);
  const lastKind = useRef(p.kind);

  // A refusal belongs to the posture it was first shown under; a new posture retires it.
  useEffect(() => {
    if (reason === null || pending !== null) return;
    if (reason.kind === null) reasonSignal.value = { ...reason, kind: p.kind };
    else if (reason.kind !== p.kind) clearReason();
  }, [p.kind, pending, reason]);

  // Nudge: two small shakes once per move into an attention, never a loop.
  useEffect(() => {
    const was = lastKind.current;
    lastKind.current = p.kind;
    if (p.kind === 'needs-attention' && was !== p.kind && card.current !== null) {
      void play(card.current, [{ transform: 'none' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' },
        { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], { duration: DUR[3] });
    }
  }, [p.kind]);

  const facts = { status, prune, now };
  const narrated = op !== null && NARRATES.has(p.kind);
  const line = narrated ? liveOpText(op)
    : p.kind === 'needs-attention' && p.attention !== null
      ? attentionSentence(p.attention, { maxAttempts: status?.recovery?.maxAttempts ?? null, unconfirmed: status?.actionsUnconfirmed ?? null })
      : sentenceOf(p, facts);
  const next = nextLineOf(p, facts);
  const progress = narrated ? liveOpProgress(op) : null;
  const fraction = progress !== null && progress.total !== null && progress.total > 0 ? Math.min(1, progress.done / progress.total) : null;
  const glyph = p.kind === 'working' && p.overlay.boost ? 'bolt' : RING_GLYPH[p.kind];
  const why = reasonOf(p);

  return (
    <section class="sb-now" data-zone="now" data-tour="now" data-tone={p.tone} data-kind={p.kind}>
      <div class="sb-now__card" ref={card}>
        <div class="sb-now__row">
          <StatusRing busy={p.busy} countdown={p.countdown} glyph={glyph} brand={false} />
          <div class="sb-now__text">
            <div class="sb-now__head">
              <h2 class="sb-now__word">{headlineOf(p, prune)}</h2>
              {p.overlay.boost ? (
                <span class="sb-pill sb-pill--boost">
                  <Icon name="bolt" /> {PILL.boost}
                </span>
              ) : null}
              {p.overlay.practice ? <span class="sb-pill">{PILL.practice}</span> : null}
            </div>
            <p class="sb-now__line" data-now-line="">
              <NowWords text={line} />
            </p>
            {next !== null ? (
              <p class="sb-now__next num">
                <span>{next}</span>
                <WhyButton posture={p} />
              </p>
            ) : null}
            {fraction === null ? null : (
              <span class="sb-now__progress" aria-hidden="true">
                <i style={{ transform: `scaleX(${fraction})` }} />
              </span>
            )}
          </div>
        </div>
        <TransportRow posture={p} />
        {why === null ? null : (
          <p class="sb-now__reason" role="status">
            <Icon name="circle-exclamation" />
            <span>{why}</span>
          </p>
        )}
      </div>
    </section>
  );
}
