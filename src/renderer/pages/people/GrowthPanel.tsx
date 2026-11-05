import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { statusSignal } from '@/renderer/app/shell-context';
import { GrowthChart } from '@/renderer/charts/GrowthChart';
import { DEFAULT_GROWTH_WINDOW, GROWTH_WINDOWS, type GrowthWindowKey } from '@/renderer/charts/growth-window';
import { useGrowthSeries } from '@/renderer/hooks/useGrowthSeries';
import { commas } from '@/renderer/lib/format';
import { Segmented } from '@/renderer/ui/Segmented';

/** A signed count with a true minus sign: "+182", "−4", "0". */
export function signedCount(n: number): string {
  if (n > 0) return `+${commas(n)}`;
  if (n < 0) return `−${commas(-n)}`;
  return '0';
}

/**
 * "Your followers over time" (spec §12.5): the measured net change only, on
 * calendar days, with the follower count Epo last read from the profile. No
 * projection: every point is something that happened.
 */
export function GrowthPanel({ active }: { active: boolean }): JSX.Element {
  const [win, setWin] = useState<GrowthWindowKey>(DEFAULT_GROWTH_WINDOW);
  const status = statusSignal.value;
  const { points, baselineAt, forWindow } = useGrowthSeries(win, status, active);
  const followers = status?.own?.followers ?? null;
  const last = points[points.length - 1];
  const span = win === 'all' ? 'since Epo began measuring' : `in ${GROWTH_WINDOWS.find((w) => w.value === win)?.label ?? ''}`;

  return (
    <section class="people-panel people-growth" aria-labelledby="people-growth-h">
      <div class="people-panel__head">
        <h2 id="people-growth-h">Your followers over time</h2>
        <Segmented options={GROWTH_WINDOWS} value={win} onChange={(v) => setWin(v)} ariaLabel="Range" />
      </div>
      {followers !== null || last !== undefined ? <div class="people-growth__num num">
        {followers !== null ? <span class="people-growth__count">{commas(followers.count)}</span> : null}
        {last !== undefined ? (
          <span class={last.cumulativeNet > 0 ? 'people-growth__delta is-up' : 'people-growth__delta'}>
            {signedCount(last.cumulativeNet)} {span}
          </span>
        ) : null}
      </div> : null}
      <GrowthChart points={points} revealKey={forWindow} baselineAt={baselineAt} />
      <p class="people-growth__note">Calendar days · measured from your profile</p>
    </section>
  );
}
