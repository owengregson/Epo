/**
 * The one Boost control (spec §8.6): one tap starts a Boost of the length saved in Settings, and while a
 * Boost window is open its footer shows the window and one-tap End. The button waits, with its reason,
 * until Boost can change something; what one tap would do shows on hover or focus.
 */
import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Res } from '@/ipc/contract';
import { useNow } from '@/renderer/app/clock';
import { settingsViewSignal, statusSignal, useShell, useShellControls } from '@/renderer/app/shell-context';
import { BOOST_COPY } from '@/renderer/copy/boost';
import { DUR } from '@/renderer/design/motion-scale';
import { type Box, place } from '@/renderer/lib/anchor';
import { armDeadline } from '@/renderer/lib/deadline-anim';
import { BOOST_NEEDS_PLAN, bandLine, buttonLabel, previewLine } from '@/renderer/sidebar/boost-copy';
import { postureSignal } from '@/renderer/sidebar/posture-signal';
import { noteFailure, noteRefusal } from '@/renderer/sidebar/reason-line';
import { Icon } from '@/renderer/ui/Icon';

type Preview = Res<'previewBoost'>;

/** The hover card's trigger bounds in column coordinates, and the line it shows. */
const boostCardSignal = signal<{ readonly anchor: Box; readonly line: string } | null>(null);

/** Why the button waits, or null when one tap would do something. */
function waitReason(preview: Preview): string | null {
  const view = settingsViewSignal.value;
  const p = postureSignal.value;
  if (view === null || !view.capabilities.boost) return BOOST_NEEDS_PLAN;
  if (p.kind === 'signed-out' || p.kind === 'data-unavailable') return BOOST_COPY.unavailable.signedOut;
  if (p.kind === 'needs-seed') return BOOST_COPY.unavailable.noSeed;
  if (p.kind === 'needs-attention') return BOOST_COPY.unavailable.attention;
  if (preview?.why === 'nothing-to-shift') return BOOST_COPY.control.nothingToShift;
  if (preview?.why === 'backlog') return BOOST_COPY.control.backlog.replace(/ in about \{d\} days\./, ' once more of them are done.');
  return null;
}

function Band({ boost }: { boost: NonNullable<Res<'status'>['boost']> }): JSX.Element {
  const { toast } = useShell();
  const now = useNow('minute');
  const bar = useRef<HTMLElement>(null);
  const from = boost.startedAt;
  const to = boost.endsAt;
  useLayoutEffect(() => {
    if (bar.current === null || from === null || to === null || boost.state !== 'on') return;
    const anim = armDeadline(bar.current, { from, to, toward: 'resume' }, Date.now(), 'scaleX');
    return () => anim?.cancel();
  }, [from, to, boost.state]);
  const end = async (): Promise<void> => {
    try {
      const r = await window.epo.endBoost();
      if (r.kind === 'refused') noteRefusal(r.reason);
      else toast('info', BOOST_COPY.control.ended);
    } catch {
      noteFailure();
    }
  };
  const left = from !== null && to !== null && to > from ? Math.max(0, Math.min(1, (to - now) / (to - from))) : 0;
  return (
    <div class={`sb-band is-${boost.state}`} data-boost={boost.state}>
      <Icon name="bolt" />
      <span class="sb-band__text">{bandLine(boost, now)}</span>
      <button type="button" class="sb-btn sb-btn--small" onClick={() => void end()}>
        {BOOST_COPY.control.end}
      </button>
      {boost.state === 'on' ? <i class="sb-band__left" ref={bar} style={{ transform: `scaleX(${left})` }} /> : null}
    </div>
  );
}

export function BoostControl(): JSX.Element {
  const status = statusSignal.value;
  const view = settingsViewSignal.value;
  const controls = useShellControls();
  const boost = status?.boost ?? null;
  const hours = view?.prefs.boost.hours ?? null;
  const capable = view?.capabilities.boost === true;
  const stopped = status?.state === 'idle' || status?.state === 'halted';
  const [preview, setPreview] = useState<Preview>(null);
  const button = useRef<HTMLButtonElement>(null);
  const off = boost === null || boost.state === 'off';
  const revision = status?.plan?.revision ?? null;

  useEffect(() => {
    if (!capable || !off || hours === null) {
      setPreview(null);
      return;
    }
    let alive = true;
    window.epo.previewBoost(hours).then((p) => alive && setPreview(p), () => alive && setPreview(null));
    return () => {
      alive = false;
    };
  }, [capable, off, hours, revision, status?.state]);

  if (!off && boost !== null) return <Band boost={boost} />;

  const reason = waitReason(preview);
  const plan = status?.plan ?? null;
  const line = preview === null ? null : previewLine(preview, plan?.now.nextAt ?? null, plan?.kinds.follow.planned ?? null);
  const showCard = (): void => {
    cancelClose();
    const el = button.current;
    const column = el?.closest('.sidebar');
    if (el === null || column == null || line === null || reason !== null) return;
    const trigger = el.getBoundingClientRect();
    const bounds = column.getBoundingClientRect();
    boostCardSignal.value = {
      anchor: { x: trigger.left - bounds.left, y: trigger.top - bounds.top, w: trigger.width, h: trigger.height },
      line,
    };
  };
  const start = async (): Promise<void> => {
    if (hours === null) return;
    boostCardSignal.value = null;
    try {
      const r = await window.epo.startBoost(hours, { alsoStart: stopped });
      if (r.kind === 'refused') noteRefusal(r.reason);
    } catch {
      noteFailure();
    }
  };
  const label = buttonLabel(hours, stopped && capable);
  return (
    <div class="sb-boostrow">
      {/* A disabled button gets no pointer events, so its reason rides the wrapper's tooltip. */}
      <span class="sb-boost" data-tip={reason ?? undefined}>
        <button
          type="button"
          ref={button}
          class="sb-btn sb-btn--boost"
          disabled={reason !== null}
          aria-label={reason === null ? undefined : `${label}. ${reason}`}
          onMouseEnter={showCard}
          onFocus={showCard}
          onMouseLeave={closeSoon}
          onBlur={closeSoon}
          onClick={() => void start()}
        >
          <Icon name="bolt" />
          {label}
        </button>
      </span>
      <button type="button" class="sb-link sb-boostrow__settings" onClick={() => controls.openSettings({ section: 'boost' })}>
        {BOOST_COPY.control.changeLength}
      </button>
    </div>
  );
}

let closing: ReturnType<typeof setTimeout> | null = null;
function cancelClose(): void {
  if (closing !== null) clearTimeout(closing);
  closing = null;
}
/** Close after a moment, so the pointer can travel from the button into the card. */
function closeSoon(): void {
  cancelClose();
  closing = setTimeout(() => {
    closing = null;
    boostCardSignal.value = null;
  }, DUR[2]);
}

/** The card beside the Boost button: what one tap would do, and where its length is chosen. */
export function BoostCard(): JSX.Element | null {
  const card = boostCardSignal.value;
  const controls = useShellControls();
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    const column = node?.closest<HTMLElement>('.sidebar');
    if (node == null || column == null || card === null) return;
    // Flip fully above a bottom-edge trigger; a clamp alone would cover its click target.
    const at = place(card.anchor, { w: node.offsetWidth, h: node.offsetHeight },
      { w: column.clientWidth, h: column.clientHeight }, { side: 'below' });
    node.style.top = `${at.top}px`;
    const close = (): void => { boostCardSignal.value = null; };
    const middle = column.querySelector('.sb-middle');
    middle?.addEventListener('scroll', close);
    window.addEventListener('resize', close);
    return () => {
      middle?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [card]);
  if (card === null) return null;
  return (
    <div
      ref={el}
      class="sb-boostcard"
      role="tooltip"
      style={{ top: `${card.anchor.y + card.anchor.h + 8}px` }}
      onMouseEnter={cancelClose}
      onMouseLeave={closeSoon}
    >
      <p>{card.line}</p>
      <button type="button" class="sb-link" onClick={() => controls.openSettings({ section: 'boost' })}>
        {BOOST_COPY.control.changeLength}
      </button>
    </div>
  );
}
