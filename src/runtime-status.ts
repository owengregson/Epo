/** Browser-safe operational projection of the durable device coordinator. */
export interface RuntimeStatus {
  desired: 'stopped' | 'paused' | 'running';
  phase: 'ready' | 'suspended' | 'reconciling' | 'recovering';
  blockedReason: string | null;
  lastProgressAt: number | null;
  progressPhase: string | null;
  incidents: { at: number; reason: string; detail?: string }[];
}
