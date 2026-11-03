import type { SqliteDriver } from '../driver/driver';
import type { MetaRepo } from './meta';

/**
 * Persisted drift signatures, per-plan-day surface health (migration 16) and
 * the latency meter (`meta.surface_meter`). A skeleton: the parse-health stream
 * adds the writes and reads behind its production sink.
 */
export class SurfaceDriftRepo {
  constructor(
    protected readonly db: SqliteDriver,
    protected readonly meta: MetaRepo,
    protected readonly changed: () => void,
  ) {}
}
