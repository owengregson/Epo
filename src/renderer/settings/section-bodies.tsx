import type { JSX } from 'preact';
import type { SectionId } from '@/shared/settings-params';
import { AppExtras, ProtectionExtras } from './advanced/Extras';
import { DiagnosticsSection, ExploreSection, LimitsSection, TechnicalSection, TimingSection } from './sections/AdvancedSections';
import { AppSection } from './sections/AppSection';
import { AudienceSection } from './sections/AudienceSection';
import { BoostSection } from './sections/BoostSection';
import { PaceSection } from './sections/PaceSection';
import { ProtectionSection } from './sections/ProtectionSection';
import { ScheduleSection } from './sections/ScheduleSection';
import { UnfollowSection } from './sections/UnfollowSection';
import type { SectionProps } from './stage-api';

/** Each section's controls under its heading. */
export const SECTION_BODIES: Readonly<Record<SectionId, (p: SectionProps) => JSX.Element | null>> = {
  pace: PaceSection,
  schedule: ScheduleSection,
  audience: AudienceSection,
  unfollow: UnfollowSection,
  protection: ProtectionSection,
  boost: BoostSection,
  app: AppSection,
  timing: TimingSection,
  explore: ExploreSection,
  limits: LimitsSection,
  technical: TechnicalSection,
  diagnostics: DiagnosticsSection,
};

/** What Advanced adds under an Easy section, after its Fine-tune rows. */
export const ADVANCED_EXTRAS: Partial<Record<SectionId, (p: SectionProps) => JSX.Element>> = {
  protection: ProtectionExtras,
  app: AppExtras,
};
