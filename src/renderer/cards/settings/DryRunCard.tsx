/** @jsx h */
import { h } from 'preact';
import type { Settings } from '@/types';
import { Card, CardBody } from '@/renderer/ui/Card';
import { Toggle } from '@/renderer/ui/Toggle';
import type { SettingsDraftController } from '@/renderer/hooks/useSettingsDraft';

export interface DryRunCardProps {
  draft: Settings;
  set: SettingsDraftController['set'];
}

/**
 * Dry run — a single headerless card: label + explainer on the left, the
 * simulate-everything toggle on the right (the shared `.kv` row keeps them
 * aligned without any bespoke layout).
 */
export function DryRunCard({ draft: d, set }: DryRunCardProps): h.JSX.Element {
  return (
    <Card index={7}>
      <CardBody>
        <div class="kv">
          <div class="k">
            <div>
              <div data-tip="Simulates every decision — targeting, timing, queueing — and logs it, without sending anything to Instagram. Perfect for tuning settings risk-free.">
                Dry run
              </div>
              <div class="hint">Simulate every action — nothing is sent to Instagram</div>
            </div>
          </div>
          <div class="v">
            <Toggle checked={d.dryRun} onChange={(v) => set('dryRun', v)} ariaLabel="Dry run" />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
