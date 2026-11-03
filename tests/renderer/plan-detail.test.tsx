/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * "Today's plan in detail" (spec §6.5): every detail field the plan carries renders, read-only; without a
 * built plan the block says so and shows no digit at all.
 */
import { render, screen } from '@testing-library/preact';
import { GALLERY_PLAN } from '@/renderer/gallery/fixtures-settings';
import { PlanDetail } from '@/renderer/settings/advanced/PlanDetail';
import { minuteLabel, spanLabel, waitLabel } from '@/renderer/settings/format';
import { NOT_BUILT_FIELDS } from '@/shared/status-fields';
import { idleStatus } from '../kit/render-bridge';

const block = () => document.querySelector('[data-row="plan.detail"]') as HTMLElement;

describe('today’s plan in detail', () => {
  it('renders the plan-day, every cap and every session field', () => {
    render(<PlanDetail status={idleStatus({ plan: GALLERY_PLAN })} />);
    const text = block().textContent ?? '';
    const caps = GALLERY_PLAN.detail.caps;
    expect(text).toContain(spanLabel(GALLERY_PLAN.day.startsAt, GALLERY_PLAN.day.endsAt));
    expect(text).toContain(minuteLabel(GALLERY_PLAN.day.quietMinute));
    for (const [label, v] of [
      ['Epo’s own maximum', caps.automaticMax], ['Hard stop', caps.day], ['At most an hour', caps.hour],
      ['Unfollows an hour', caps.unfollowHour], ['While easing back in', caps.probationHour], ['Approvals per check', caps.acceptsPerPass],
    ] as const) {
      const dt = screen.getByText(label, { selector: 'dt' });
      expect(dt.nextElementSibling?.textContent).toBe(String(v));
    }
    for (const d of GALLERY_PLAN.detail.sessions) {
      const s = GALLERY_PLAN.sessions[d.idx];
      if (s === undefined) throw new Error('fixture session missing');
      expect(text).toContain(spanLabel(s.startAt, s.endAt));
      for (const ms of [d.gap.targetMeanMs, d.gap.medianMs, d.gap.floorMs, d.gap.capMs]) expect(text).toContain(waitLabel(ms / 1000));
      for (const f of [d.pace, d.motion, d.depth]) expect(text).toContain(`×${f.toFixed(2)}`);
      const rows = block().querySelectorAll('tbody tr');
      const first = [...rows].find((r) => r.firstElementChild?.textContent?.trim() === String(d.idx + 1));
      expect(first?.textContent).toContain(String(d.kinds.follow));
      const tempoRow = [...rows].filter((r) => r.firstElementChild?.textContent?.trim() === String(d.idx + 1))[1];
      expect(tempoRow?.textContent).toContain(`${d.reads.profiles}${d.reads.pages}${d.reads.checks}`);
    }
  });

  it('shows no digit from a not-built projection', () => {
    render(<PlanDetail status={{ ...idleStatus({ plan: GALLERY_PLAN }), ...NOT_BUILT_FIELDS, plan: GALLERY_PLAN }} />);
    expect(block().textContent).toMatch(/appears here once Epo has opened your account/);
    expect(block().textContent).not.toMatch(/\d/);
  });

  it('shows no digit before the plan exists', () => {
    render(<PlanDetail status={idleStatus({ plan: null })} />);
    expect(block().textContent).not.toMatch(/\d/);
    render(<PlanDetail status={null} />);
    expect(document.querySelectorAll('[data-row="plan.detail"]')[1]?.textContent).not.toMatch(/\d/);
  });
});
