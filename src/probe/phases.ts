/**
 * Probe phases that run INSTEAD of the health reads (each module's header says
 * exactly what it asks Instagram for — most ask nothing beyond ordinary
 * browsing). `probe-main.ts` dispatches here before `health`.
 */

import type { InstagramTab } from '@/adapter/tab';
import { drawerProbe } from '@/probe/drawer';
import { endpointCheck } from '@/probe/endpoints';
import { headerExperiment } from '@/probe/headers';
import { notificationsProbe } from '@/probe/notifications';
import { traffic } from '@/probe/traffic';
import { visitProbe } from '@/probe/visit';

export const SOLO_PHASES: Record<string, (tab: InstagramTab, out: string) => Promise<void>> = {
  /** Passive: browse, record IG's own client. Composes no request. */
  traffic,
  /** Two dialog-sized followers reads (Epo's headers vs the client's). */
  headers: headerExperiment,
  /** One read per composed endpoint; stops at the first wall. */
  endpoints: endpointCheck,
  /** Hover diagnosis + one production drawer click. */
  notifications: notificationsProbe,
  /** Rail structure + an icon press that opens the drawer; nothing confirmed. */
  drawer: drawerProbe,
  /** Rail/close settle timing + one nonexistent-profile page load. */
  visit: visitProbe,
};
