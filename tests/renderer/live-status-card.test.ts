/**
 * LiveStatusCard pure helpers — the step-label map and the park-hold copy.
 * A running-but-parked engine renders a first-class hold (headline + why +
 * resume time) instead of the "running with dashes" that read as broken.
 */
import {
  holdChipText,
  parkCaption,
  parkHeadline,
  recoveryHoldCaption,
  stepLabel,
} from '@/renderer/cards/overview/LiveStatusCard';
import type { EpoStatus } from '@/types';

type Step = NonNullable<EpoStatus['lastStep']>;

const t = (iso: string): number => Date.parse(iso); // local time, engine-test style

describe('stepLabel — every StepResult reads as itself', () => {
  it("labels 'waited-session' (the organic park) instead of falling through to idle", () => {
    expect(stepLabel('waited-session')).toBe('waited · session');
  });

  it('gives each wait state a distinct non-idle label', () => {
    const waits: Step[] = ['waited-active-hours', 'waited-session', 'waited-ceiling'];
    const labels = waits.map(stepLabel);
    expect(new Set(labels).size).toBe(waits.length);
    for (const label of labels) expect(label).not.toBe('idle');
  });
});

describe('park hold copy — plain reason + real resume time', () => {
  it('active-hours: resting until the window opens (cross-midnight says tomorrow)', () => {
    expect(parkHeadline('active-hours')).toBe('Resting');
    expect(
      parkCaption('active-hours', t('2026-08-13T08:00:00'), t('2026-08-12T23:00:00'), 0, 40),
    ).toBe('outside active hours · resumes tomorrow 8:00');
  });

  it('daily-ceiling: the real plan numbers and the reset time', () => {
    expect(parkHeadline('daily-ceiling')).toBe('Plan done');
    expect(
      parkCaption('daily-ceiling', t('2026-08-13T08:00:00'), t('2026-08-12T20:15:00'), 47, 47),
    ).toBe("today's plan is done (47/47) · resumes tomorrow 8:00");
  });

  it('session: between sessions with the next session start (same day, no tomorrow)', () => {
    expect(
      parkCaption('session', t('2026-08-12T14:10:00'), t('2026-08-12T13:50:00'), 12, 40),
    ).toBe('between sessions · next session 14:10');
  });

  it('velocity: easing off with the resume time', () => {
    expect(parkHeadline('velocity')).toBe('Pacing');
    expect(
      parkCaption('velocity', t('2026-08-12T13:40:00'), t('2026-08-12T13:05:00'), 12, 40),
    ).toBe('easing off this hour · resumes 13:40');
  });

  it('enrich-backoff: honest fetch-trouble copy with the retry time', () => {
    expect(parkHeadline('enrich-backoff')).toBe('Backing off');
    expect(
      parkCaption('enrich-backoff', t('2026-08-12T14:32:00'), t('2026-08-12T14:22:00'), 12, 40),
    ).toBe('after fetch trouble · retrying 14:32');
  });
});

describe('holdChipText — the countdown chip beside a hold', () => {
  it('counts short holds down in m:ss', () => {
    const now = t('2026-08-12T13:50:00');
    const until = t('2026-08-12T14:10:00');
    expect(holdChipText(until, now, 20 * 60)).toBe('in 20:00');
  });

  it('renders long holds as h m', () => {
    const now = t('2026-08-12T20:15:00');
    const until = t('2026-08-13T08:00:00');
    expect(holdChipText(until, now, Math.round((until - now) / 1000))).toBe('in 11h 45m');
  });

  it("says resuming… once the deadline passes instead of a dead 'in 0:00'", () => {
    const until = t('2026-08-12T14:10:00');
    expect(holdChipText(until, until, 0)).toBe('resuming…');
    expect(holdChipText(until, until + 5_000, 0)).toBe('resuming…');
  });
});

describe('recovery ladder copy', () => {
  it('recovery park: headline Backing off, rung-aware caption with the resume time', () => {
    expect(parkHeadline('recovery')).toBe('Backing off');
    expect(
      recoveryHoldCaption(
        { attempt: 2, maxAttempts: 3, resumeAt: t('2026-08-12T14:32:00') },
        t('2026-08-12T13:05:00'),
      ),
    ).toBe("recent actions aren't landing · retrying ~14:32 (attempt 2 of 3)");
  });

  it('probing has no resume time and says soon', () => {
    expect(
      recoveryHoldCaption({ attempt: 1, maxAttempts: 3, resumeAt: null }, t('2026-08-12T13:05:00')),
    ).toBe("recent actions aren't landing · retrying soon (attempt 1 of 3)");
  });
});
