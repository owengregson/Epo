import { type JSX } from 'preact';
import { logSignal } from '@/renderer/app/shell-context';
import { clockTime } from '@/renderer/lib/format';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import type { LogEntry } from '@/types';

/** How many of the newest lines the Overview pane shows. */
const VISIBLE_LINES = 7;

/** Level → `.lv` tone class (debug reads as info in the console pane). */
function levelClass(level: LogEntry['level']): 'info' | 'warn' | 'error' {
  switch (level) {
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

/**
 * Activity — the newest slice of the streamed structured log, newest first
 * (the full rolling buffer lives on {@link logSignal}, which this card reads
 * directly so a streamed line re-renders nothing above it).
 */
export function ActivityCard(): JSX.Element {
  const recent = logSignal.value.slice(-VISIBLE_LINES).reverse();

  return (
    <Card>
      <CardHeader icon="wave-square">Activity</CardHeader>
      <CardBody>
        <div class="log">
          {recent.length === 0 ? (
            <div class="ln">
              <span class="msg">No activity yet.</span>
            </div>
          ) : (
            recent.map((line) => {
              const lv = levelClass(line.level);
              return (
                <div class="ln" key={line.seq}>
                  <span class="ts num">{clockTime(line.at)}</span>
                  <span class={`lv ${lv}`}>{lv}</span>
                  <span class="msg">{line.message}</span>
                </div>
              );
            })
          )}
        </div>
      </CardBody>
    </Card>
  );
}
