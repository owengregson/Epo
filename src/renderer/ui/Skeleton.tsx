import type { JSX } from 'preact';

export interface SkeletonProps {
  /** How many placeholder lines stand in for the content (its final height, not a guess at numbers). */
  lines: number;
  /** What is loading, for assistive tech ("Loading your sources"). */
  label: string;
}

/**
 * A final-size placeholder for data that is not known yet (spec §12.1, law
 * L-ZERO): shapes, never digits, so nothing reads as a real zero while a
 * projection is still on its way.
 */
export function Skeleton({ lines, label }: SkeletonProps): JSX.Element {
  return (
    <div class="skeleton" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} class="skeleton-line" />
      ))}
    </div>
  );
}
