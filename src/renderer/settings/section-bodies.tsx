import type { JSX } from 'preact';
import type { SectionId } from '@/shared/settings-params';
import { AppSection } from './sections/AppSection';
import { AudienceSection } from './sections/AudienceSection';
import { BoostSection } from './sections/BoostSection';
import { PaceSection } from './sections/PaceSection';
import { ProtectionSection } from './sections/ProtectionSection';
import { ScheduleSection } from './sections/ScheduleSection';
import { UnfollowSection } from './sections/UnfollowSection';
import type { SectionProps } from './stage-api';

/** The Advanced-only sections' bodies arrive with Advanced. */
const empty = (_p: SectionProps): JSX.Element | null => null;

/** Each section's controls under its heading. */
export const SECTION_BODIES: Readonly<Record<SectionId, (p: SectionProps) => JSX.Element | null>> = {
  pace: PaceSection,
  schedule: ScheduleSection,
  audience: AudienceSection,
  unfollow: UnfollowSection,
  protection: ProtectionSection,
  boost: BoostSection,
  app: AppSection,
  timing: empty,
  explore: empty,
  limits: empty,
  technical: empty,
  diagnostics: empty,
};
