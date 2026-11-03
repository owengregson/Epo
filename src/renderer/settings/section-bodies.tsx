import type { JSX } from 'preact';
import type { SectionId } from '@/shared/settings-params';
import type { SectionProps } from './stage-api';

/** Each section's controls under its heading (filled section by section). */
const empty = (_p: SectionProps): JSX.Element | null => null;

export const SECTION_BODIES: Readonly<Record<SectionId, (p: SectionProps) => JSX.Element | null>> = {
  pace: empty,
  schedule: empty,
  audience: empty,
  unfollow: empty,
  protection: empty,
  boost: empty,
  app: empty,
  timing: empty,
  explore: empty,
  limits: empty,
  technical: empty,
  diagnostics: empty,
};
