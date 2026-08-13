/** @jsx h */
import { h } from 'preact';
import type { LogEntry } from '@/types';
import { Card, CardHeader, CardBody } from '@/renderer/ui/Card';
import { clockTime } from '@/renderer/lib/format';

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

export interface ActivityCardProps {
  logLines: LogEntry[];
}

/**
 * Activity — the newest slice of the streamed structured log, newest first
 * (the full rolling buffer lives in the shell's log feed).
 */
export function ActivityCard({ logLines }: ActivityCardProps): h.JSX.Element {
  const recent = logLines.slice(-VISIBLE_LINES).reverse();

  return (
    <Card index={4}>
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
                <div class="ln" key={`${line.at}:${line.message}`}>
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
