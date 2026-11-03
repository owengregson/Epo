/**
 * The column's fixed top and bottom: the masthead (one band with the stage bar),
 * the Now zone (the one raised surface) and the footer.
 */
import { type JSX } from 'preact';
import { ACCOUNT, VERSION } from '@/renderer/gallery/direction/fixtures';
import { Ring, Said } from '@/renderer/gallery/direction/instruments';
import type { PostureSpec } from '@/renderer/gallery/direction/postures';
import type { Tone } from '@/renderer/gallery/direction/proposed-tokens';
import { EpoMark } from '@/renderer/ui/EpoMark';
import { Icon } from '@/renderer/ui/Icon';

/** The mark (breathing while live), the wordmark, the account and its connection dot. */
export function Masthead({ tone, online = true }: { tone: Tone; online?: boolean }): JSX.Element {
  return (
    <header class="dx-mast" data-zone="masthead" data-tone={tone} style="height:44px">
      <span class="dx-mast__mark">
        <EpoMark size={24} label={null} />
      </span>
      <span class="dx-mast__word">Epo</span>
      <span class="dx-mast__acct">{ACCOUNT}</span>
      <span class={online ? 'dx-dot' : 'dx-dot is-off'} title={online ? 'Online' : 'Offline'} />
    </header>
  );
}

function Pill({ kind }: { kind: 'boost' | 'practice' }): JSX.Element {
  return kind === 'boost' ? (
    <span class="dx-pill dx-pill--boost">
      <Icon name="bolt" /> Boost
    </span>
  ) : (
    <span class="dx-pill">Practice</span>
  );
}

/** Popover drawn open in the catching-up frame: the steps of the launch check. */
function CatchUpWhy(): JSX.Element {
  const steps: Array<[string, 'done' | 'now' | 'todo']> = [
    ['Opening your profile', 'done'],
    ['Confirming your account', 'done'],
    ['Checking your notifications', 'now'],
    ['Looking at your newest followers', 'todo'],
  ];
  return (
    <div class="dx-pop dx-pop--why" role="dialog" aria-label="Why?">
      <p>
        Things changed while Epo was closed. It checks only what changed since it last ran: your profile, your
        notifications and your newest followers.
      </p>
      <ul>
        {steps.map(([label, state]) => (
          <li key={label} class={`is-${state}`}>
            <span class="dx-pop__tick">{state === 'done' ? <Icon name="check" /> : null}</span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Now: posture word, what is happening, what comes next and when, and the one primary action. */
export function NowZone({ p, compact, height }: { p: PostureSpec; compact: boolean; height: number }): JSX.Element {
  const twoLine = p.next === null;
  return (
    <section class={compact ? 'dx-now is-compact' : 'dx-now'} data-zone="now" data-tone={p.tone} style={`height:${height}px`}>
      <div class="dx-now__card">
        <div class="dx-now__row">
          <Ring size={compact ? 72 : 88} mode={p.ring.mode} fraction={p.ring.fraction} glyph={p.ring.glyph} />
          <div class="dx-now__text">
            <div class="dx-now__head">
              <h2 class="dx-now__word">{p.headline}</h2>
              {p.pills.map((k) => (
                <Pill key={k} kind={k} />
              ))}
            </div>
            <p class={twoLine ? 'dx-now__line is-two' : 'dx-now__line'}>
              <Said parts={p.nowLine} />
            </p>
            {p.next ? (
              <p class="dx-now__next">
                <span>{p.next}</span>
                {p.why ? (
                  <button type="button" class="dx-why">
                    Why?
                  </button>
                ) : null}
              </p>
            ) : null}
            <span class="dx-now__progress" aria-hidden="true">
              {p.progress === null ? null : <i style={`transform:scaleX(${p.progress})`} />}
            </span>
          </div>
        </div>
        <div class="dx-now__buttons">
          {p.primary ? (
            <button type="button" class="dx-btn dx-btn--primary">
              <Icon name={p.primary.icon} brand={p.primary.brand} />
              {p.primary.label}
            </button>
          ) : null}
          {p.secondary ? (
            <button type="button" class="dx-btn dx-btn--ghost">
              {p.secondary}
            </button>
          ) : null}
        </div>
        <p class="dx-now__reason">
          {p.reason ? (
            <>
              <Icon name="circle-exclamation" />
              {p.reason}
            </>
          ) : null}
        </p>
      </div>
      {p.popover === 'why-catching-up' ? <CatchUpWhy /> : null}
    </section>
  );
}

/** Version (or the update action) and the way into Diagnostics. */
export function Footer(): JSX.Element {
  return (
    <footer class="dx-foot" data-zone="footer" style="height:36px">
      <span>{VERSION}</span>
      <button type="button" class="dx-link">
        Diagnostics
      </button>
    </footer>
  );
}
