// =============================================================================
// MemoriaHubTelemetryModule (RETRO-T3, #628)
// =============================================================================
//
// MemoriaHub's own telemetry providers: the shared reads
// (`MemoriaHubTelemetrySignals`), the gauge providers (`MemoriaHubGaugesService`,
// registered at module init) and the verdict policy's dependency. Imported ONCE,
// by `TelemetryModule.forRoot({ imports })` in `platform/telemetry/telemetry.config.ts`,
// so `MemoriaHubVerdictPolicy` (built inside the telemetry module) can inject the
// signals. PrismaService and JobHandlerRegistry are global.
// =============================================================================

import { Module } from '@nestjs/common';

import { MemoriaHubGaugesService } from './memoriahub-gauges.service';
import { MemoriaHubTelemetrySignals } from './memoriahub-telemetry-signals.service';

@Module({
  providers: [MemoriaHubTelemetrySignals, MemoriaHubGaugesService],
  exports: [MemoriaHubTelemetrySignals],
})
export class MemoriaHubTelemetryModule {}
