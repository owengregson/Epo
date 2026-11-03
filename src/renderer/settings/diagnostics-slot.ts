import { signal } from '@preact/signals';
import type { ComponentType } from 'preact';

/**
 * Where Settings › Diagnostics mounts the log panel (spec §6.5). The sidebar stream's `DiagnosticsPanel`
 * fills it once at startup (`diagnosticsPanelSlot.value = DiagnosticsPanel`); until then the section says
 * where the log will appear.
 */
export const diagnosticsPanelSlot = signal<ComponentType | null>(null);
