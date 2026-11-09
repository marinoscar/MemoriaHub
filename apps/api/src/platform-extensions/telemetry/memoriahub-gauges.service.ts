// =============================================================================
// MemoriaHub's gauge providers (RETRO-T3, #628)
// =============================================================================
//
// Registers the five MemoriaHub gauges on the platform's metrics host once, at
// module init: `app.media.processing.backlog`, `app.enrichment.pending`,
// `app.storage.bytes`, `app.storage.trash.bytes`, `app.nodes.capability`.
// Names, units and descriptions come from the app-metric registry
// (`createRegisteredGauge`); the data from `MemoriaHubTelemetrySignals` (60 s
// memo). A callback reads NOTHING while the export gate is closed, and nothing
// is registered at all when gauges are off in this process (`gaugeContext()`
// is `null`: `OTEL_ENABLED` is not `true`).
// =============================================================================

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { createRegisteredGauge, type AppGaugeContext } from '@marinoscar/platform-api/otel-core';

import { MemoriaHubTelemetrySignals } from './memoriahub-telemetry-signals.service';

@Injectable()
export class MemoriaHubGaugesService implements OnModuleInit {
  private readonly logger = new Logger(MemoriaHubGaugesService.name);
  private registered = false;

  constructor(
    private readonly signals: MemoriaHubTelemetrySignals,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  onModuleInit(): void {
    const context = this.metrics?.gaugeContext() ?? null;
    if (context) this.register(context);
  }

  /** Creates the gauges on `context`'s meter. Idempotent; never throws. */
  register(context: AppGaugeContext): boolean {
    if (this.registered) return false;
    try {
      const { meter, gateOpen } = context;
      const signals = this.signals;

      createRegisteredGauge(meter, 'mediaProcessingBacklog').addCallback(async (result) => {
        if (!gateOpen()) return;
        const counts = await signals.backlog.get();
        if (!counts) return;
        for (const [status, value] of Object.entries(counts)) result.observe(value, { status });
      });

      createRegisteredGauge(meter, 'enrichmentPending').addCallback(async (result) => {
        if (!gateOpen()) return;
        const counts = await signals.pending.get();
        if (!counts) return;
        for (const [stage, value] of Object.entries(counts)) result.observe(value, { stage });
      });

      createRegisteredGauge(meter, 'storageBytes').addCallback(async (result) => {
        if (!gateOpen()) return;
        const reading = await signals.storage.get();
        for (const row of reading?.bytes ?? []) {
          result.observe(row.bytes, { provider: boundTo(row.provider, ['s3', 'r2', 'local']), kind: row.kind });
        }
      });

      createRegisteredGauge(meter, 'storageTrashBytes').addCallback(async (result) => {
        if (!gateOpen()) return;
        const reading = await signals.storage.get();
        if (reading?.trashBytes != null) result.observe(reading.trashBytes);
      });

      createRegisteredGauge(meter, 'nodesCapability').addCallback(async (result) => {
        if (!gateOpen()) return;
        const counts = await signals.capabilities.get();
        if (!counts) return;
        for (const [capability, { ok, missing }] of Object.entries(counts)) {
          result.observe(ok, { capability, state: 'ok' });
          result.observe(missing, { capability, state: 'missing' });
        }
      });

      this.registered = true;
      return true;
    } catch (error) {
      this.logger.warn(`MemoriaHub gauges not registered: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

/** A gauge observes its attributes as given (no `add` bounding), so a provider id outside the enum reads `other`. */
function boundTo(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : 'other';
}
