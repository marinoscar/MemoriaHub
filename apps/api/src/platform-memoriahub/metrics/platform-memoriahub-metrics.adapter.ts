import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import type { MemoriahubMetricsPort } from '@marinoscar/memoriahub-api/ports';

// =============================================================================
// PlatformMemoriahubMetricsAdapter: the `MEMORIAHUB_METRICS` port over the platform metric registry
// (RETRO-J4, #610)
// =============================================================================
//
// MemoriaHub's own `app.*` names are declared in `platform-extensions/telemetry/memoriahub-metrics.manifest.ts`
// and registered with the platform's by `platform/host-core.config.ts`. `AppMetricsService` drops an
// undeclared attribute, turns a value outside an enum into `other`, never throws and does nothing while
// telemetry is off, so a wrong call site cannot widen the cardinality or break the request. No organization,
// group, user or media id is ever a label.
// =============================================================================

@Injectable()
export class PlatformMemoriahubMetricsAdapter implements MemoriahubMetricsPort {
  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  add(key: string, value?: number, attributes?: Record<string, unknown>): void {
    this.metrics?.add(key, value, attributes);
  }

  record(key: string, value: number, attributes?: Record<string, unknown>): void {
    this.metrics?.record(key, value, attributes);
  }
}
