/**
 * The compatibility report (spec §10.7): pulled on mount and again whenever `status.surface.revision`
 * changes, so an open panel ticks with the status push. A failed pull keeps the last report and says so.
 */

import { useEffect, useState } from 'preact/hooks';
import { useShell } from '@/renderer/app/shell-context';
import type { SurfaceReport } from '@/shared/surface-health';

export interface SurfaceReportState {
  /** The last report pulled, or null before the first one landed. */
  report: SurfaceReport | null;
  /** True when the latest pull failed (the last report, if any, stays shown). */
  failed: boolean;
}

export function useSurfaceReport(): SurfaceReportState {
  const { status } = useShell();
  const revision = status?.surface?.revision ?? null;
  const [state, setState] = useState<SurfaceReportState>({ report: null, failed: false });
  useEffect(() => {
    let current = true;
    window.epo.surfaceReport().then(
      (report) => { if (current) setState({ report: report ?? null, failed: false }); },
      () => { if (current) setState((prev) => ({ report: prev.report, failed: true })); },
    );
    return () => { current = false; };
  }, [revision]);
  return state;
}
