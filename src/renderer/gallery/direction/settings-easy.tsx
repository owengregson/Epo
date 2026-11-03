/**
 * Easy sections: plain questions, intent cards with live numbers, no sliders
 * and no timings (spec §6.4; copy from Appendix B.10). Card numbers are the
 * spec's illustrative values at Typical consistency.
 */
import { type JSX } from 'preact';
import { Meter } from '@/renderer/gallery/direction/instruments';
import { Icon } from '@/renderer/ui/Icon';

interface Choice {
  title: string;
  metric?: string;
  line: string;
  recommended?: boolean;
  selected?: boolean;
}

/** A radio group of intent cards; the selected one says so in words, not colour alone. */
function Cards({ name, choices, cols = 3 }: { name: string; choices: readonly Choice[]; cols?: number }): JSX.Element {
  return (
    <div class="dx-cards" role="radiogroup" aria-label={name} style={`--cols:${cols}`}>
      {choices.map((c) => (
        <button key={c.title} type="button" role="radio" aria-checked={c.selected === true} class={c.selected ? 'dx-card is-on' : 'dx-card'}>
          <span class="dx-card__top">
            <span class="dx-card__title">{c.title}</span>
            {c.recommended ? <span class="dx-tag">Recommended</span> : null}
          </span>
          {c.metric ? <span class="dx-card__metric num">{c.metric}</span> : null}
          <span class="dx-card__line">{c.line}</span>
          {c.selected ? (
            <span class="dx-card__sel">
              <Icon name="check" /> Selected
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function SectionHead({ title, question }: { title: string; question?: string }): JSX.Element {
  return (
    <div class="dx-sec__head">
      <h2>{title}</h2>
      {question ? <p>{question}</p> : null}
    </div>
  );
}

export function GrowthPaceEasy(): JSX.Element {
  return (
    <section class="dx-sec" aria-label="Growth pace">
      <SectionHead title="Growth pace" question="How quickly should Epo grow your account?" />
      <Cards
        name="Growth pace"
        choices={[
          { title: 'Gentle', metric: 'About 26 a day', line: 'Light and relaxed.' },
          {
            title: 'Balanced',
            metric: 'About 44 a day',
            line: 'Steady growth with room to spare.',
            recommended: true,
            selected: true,
          },
          { title: 'Faster', metric: 'About 66 a day', line: 'More new people each day.' },
        ]}
      />
      <p class="dx-sec__foot">Follows, unfollows and approvals together.</p>
      <p class="dx-sec__line num">Most days land between 29 and 47.</p>
      <div class="dx-safety">
        <Meter share={0.48} />
        <p>Epo’s own work never uses more than 48% of the lowest daily follow limit Instagram is known to apply.</p>
      </div>
    </section>
  );
}

/** A day shape's intensity over 24 hours, quiet hours shaded. */
function DayBars({ peaks, quiet }: { peaks: ReadonlyArray<[number, number]>; quiet: [number, number] }): JSX.Element {
  const near = (h: number, c: number): number => Math.min(Math.abs(h - c), 24 - Math.abs(h - c));
  const level = (h: number): number => Math.min(1, peaks.reduce((s, [c, w]) => s + Math.exp(-(near(h, c) ** 2) / (2 * w * w)), 0));
  const inQuiet = (h: number): boolean => (quiet[0] > quiet[1] ? h >= quiet[0] || h < quiet[1] : h >= quiet[0] && h < quiet[1]);
  return (
    <span class="dx-daybars" aria-hidden="true">
      <span class="dx-daybars__bars">
        {Array.from({ length: 24 }, (_, h) => (
          <i key={h} class={inQuiet(h) ? 'is-quiet' : undefined} style={`height:${inQuiet(h) ? 8 : 12 + level(h) * 88}%`} />
        ))}
      </span>
      <span class="dx-daybars__axis">
        <small>12 AM</small>
        <small>12 PM</small>
      </span>
    </span>
  );
}

const SHAPES: ReadonlyArray<{ title: string; peaks: Array<[number, number]>; quiet: [number, number]; rec?: boolean }> = [
  { title: 'Through the day', peaks: [[11, 2.6], [19, 2.4]], quiet: [23.5, 6], rec: true },
  { title: 'Mornings', peaks: [[8.5, 2.2]], quiet: [22.5, 5] },
  { title: 'Evenings', peaks: [[20, 2.4]], quiet: [1, 6.5] },
  { title: 'Late nights', peaks: [[0.5, 2.6]], quiet: [4.5, 8] },
  { title: 'Work hours', peaks: [[11, 2.2], [15, 2.2]], quiet: [22, 5.5] },
];

export function WhenEasy(): JSX.Element {
  return (
    <section class="dx-sec" aria-label="When Epo works">
      <SectionHead title="When Epo works" question="When should Epo be active?" />
      <div class="dx-cards dx-cards--days" role="radiogroup" aria-label="Day shape" style="--cols:3">
        {SHAPES.map((s, i) => (
          <button key={s.title} type="button" role="radio" aria-checked={i === 0} class={i === 0 ? 'dx-card is-on' : 'dx-card'}>
            <DayBars peaks={s.peaks} quiet={s.quiet} />
            <span class="dx-card__title">{s.title}</span>
            {s.rec ? <span class="dx-tag">Recommended</span> : null}
          </button>
        ))}
      </div>
      <div class="dx-row">
        <span class="dx-row__k">Quiet hours</span>
        <span class="dx-row__v num">
          11:30 PM – 6:00 AM · from your schedule
          <button type="button" class="dx-link">
            Change
          </button>
        </span>
      </div>
      <div class="dx-row">
        <span class="dx-row__k">Days off</span>
        <span class="dx-row__v">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <button key={d} type="button" class={d === 'Sun' ? 'dx-chip is-on' : 'dx-chip'} aria-pressed={d === 'Sun'}>
              {d}
            </button>
          ))}
        </span>
      </div>
      <p class="dx-sec__hint">Epo takes these days off completely (up to 6 days a week). Your daily limits don’t move to other days.</p>
      <h3 class="dx-sec__sub">Session style</h3>
      <Cards
        name="Session style"
        choices={[
          { title: 'Many short visits', line: '5–9 a day' },
          { title: 'A few regular sessions', line: '3–6 a day', recommended: true, selected: true },
          { title: 'A couple of longer sessions', line: '2–4 a day' },
        ]}
      />
    </section>
  );
}
