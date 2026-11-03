import type { JSX } from 'preact';
import { SettingsView, type SettingsViewProps } from '@/renderer/views/SettingsView';

/**
 * The Settings stage (spec §6, §12.4). For now it hosts today's settings view
 * unchanged; the Settings stage proper (Easy and Advanced over the v2 view)
 * replaces its body.
 */
export function SettingsStage(props: SettingsViewProps): JSX.Element {
  return <SettingsView {...props} />;
}
