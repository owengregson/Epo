/**
 * Settings › Advanced › Instagram compatibility (spec §10.7, Appendix D.2): every area's state with what it
 * means, the recent changes, technical details on request, and Copy report. Pulls the report on mount and on
 * every `status.surface` revision; the settings stage mounts it.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useShell } from '@/renderer/app/shell-context';
import { useSurfaceReport } from '@/renderer/hooks/useSurfaceReport';
import { shortDate } from '@/renderer/lib/format';
import { Button } from '@/renderer/ui/Button';
import {
  AREA_LABEL, type AreaReport, COMPATIBILITY_LEAD, changeLine, explanation, PAUSED_LABEL, STATE_LABEL, SURFACE_METERS,
  type SurfaceReport,
} from '@/shared/surface-health';

const COPIED = 'Report copied. It contains no usernames, names or account IDs.';

function AreaRow({ area }: { area: AreaReport }): JSX.Element {
  const why = explanation(area.area, area.state, area.paused, area.lastReadAt === null ? null : shortDate(area.lastReadAt));
  return (
    <li class="compat-area">
      <span class="compat-area__name">{AREA_LABEL[area.area]}</span>
      <span class={`compat-pill compat-pill--${area.state}`}>{STATE_LABEL[area.state]}</span>
      {why === '' ? null : <p class="compat-area__why">{why}</p>}
    </li>
  );
}

function Technical({ report }: { report: SurfaceReport }): JSX.Element {
  return (
    <div class="compat-tech">
      <ul>
        {report.changes.map((c) => (
          <li key={`${c.endpoint}|${c.cls}|${c.path}`}>
            <code>{c.endpoint}</code> · {c.cls} · <code>{c.path}</code> · {c.state} · seen {c.seen}
            {c.hint === null ? null : <> · hint <code>{c.hint}</code></>}
          </li>
        ))}
        {report.areas.map((a) => (
          <li key={a.area}>
            {AREA_LABEL[a.area]} today: {a.today.canonical} canonical, {a.today.normalized} normalized, {a.today.recovered}{' '}
            recovered, {a.today.failed} failed{a.paused.length === 0 ? '' : ` · paused: ${a.paused.map((p) => PAUSED_LABEL[p]).join(', ')}`}
          </li>
        ))}
      </ul>
      <p class="compat-tech__load">
        Typical load: {SURFACE_METERS.map((m) => `${m} ${report.meter[m].p50 ?? '–'} ms`).join(', ')}
      </p>
    </div>
  );
}

export function CompatibilityPanel(): JSX.Element {
  const { toast } = useShell();
  const { report, failed } = useSurfaceReport();
  const [details, setDetails] = useState(false);
  const copy = (): void => {
    if (report === null) return;
    navigator.clipboard.writeText(report.copyText).then(
      () => toast('success', COPIED),
      () => toast('error', "Couldn't copy the report."),
    );
  };
  return (
    <section class="compat-panel" aria-label="Instagram compatibility">
      <h3 class="compat-panel__title">Instagram compatibility</h3>
      <p class="compat-panel__lead">{COMPATIBILITY_LEAD}</p>
      {report === null ? (
        <p class="compat-panel__empty">{failed ? "Couldn't load the compatibility report." : 'Loading…'}</p>
      ) : (
        <>
          <ul class="compat-areas">{report.areas.map((a) => <AreaRow key={a.area} area={a} />)}</ul>
          {report.changes.length === 0 ? null : (
            <>
              <h4 class="compat-panel__sub">Recent changes</h4>
              <ul class="compat-changes">
                {report.changes.map((c) => <li key={`${c.endpoint}|${c.cls}|${c.path}`}>{changeLine(c, shortDate)}</li>)}
              </ul>
            </>
          )}
          <div class="compat-panel__actions">
            <button type="button" class="compat-link" aria-expanded={details} onClick={() => setDetails(!details)}>
              {details ? 'Hide technical details' : 'Show technical details'}
            </button>
            <Button onClick={copy}>Copy report</Button>
          </div>
          {details ? <Technical report={report} /> : null}
        </>
      )}
    </section>
  );
}
