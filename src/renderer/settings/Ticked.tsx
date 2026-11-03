import type { JSX } from 'preact';
import { NumberTicker } from '@/renderer/ui/NumberTicker';

/**
 * A copy line whose `{slot}` numbers roll when they change (spec §12.7 "settle"); words and non-number
 * values ("—") stay as text. Screen readers read each number once.
 */
export function Ticked({ template, values }: { template: string; values: Readonly<Record<string, number | string>> }): JSX.Element {
  const parts = template.split(/(\{\w+\})/);
  return (
    <>
      {parts.map((part, i) => {
        const slot = /^\{(\w+)\}$/.exec(part)?.[1];
        if (slot === undefined) return part;
        const v = values[slot];
        if (v === undefined) return part;
        return typeof v === 'number' ? <NumberTicker key={`${i}-${slot}`} value={v} /> : v;
      })}
    </>
  );
}
