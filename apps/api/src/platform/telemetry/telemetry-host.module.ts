// =============================================================================
// The telemetry slice's host ports (RETRO-T2, #625)
// =============================================================================
//
//   TELEMETRY_AUDIT_SINK       -> AUDIT_SINK (the platform host's, over `audit_events`)
//   TELEMETRY_SETTINGS_STORE   -> telemetry-settings-store.adapter.ts
//   TELEMETRY_CREDENTIAL_STORE -> telemetry-credentials.adapter.ts (purpose `telemetry_greptime`)
//   TELEMETRY_JOBS             -> telemetry-jobs.adapter.ts
//   TELEMETRY_AI               -> telemetry-ai.adapter.ts (DISABLED until RETRO-E4: a shim)
//   TELEMETRY_APP_INFO         -> telemetry-app-info.adapter.ts
//
// `CredentialsModule` is imported explicitly (it is not global, so the list of
// code that can read a plaintext secret stays visible in a diff). The settings
// (`SystemSettingsService`, `SystemSettingsRowStore`), jobs (`JobsService`,
// `JobHandlerRegistry`) and Prisma providers are global; `AUDIT_SINK` is the
// global platform host module's.
// =============================================================================

import { Module } from '@nestjs/common';
import { AUDIT_SINK } from '@marinoscar/platform-api/core';
import {
  TELEMETRY_AI,
  TELEMETRY_APP_INFO,
  TELEMETRY_AUDIT_SINK,
  TELEMETRY_CREDENTIAL_STORE,
  TELEMETRY_JOBS,
  TELEMETRY_SETTINGS_STORE,
} from '@marinoscar/platform-api/telemetry';

import { CredentialsModule } from '../credentials/credentials.config';
import { TelemetryAiDisabledAdapter } from './telemetry-ai.adapter';
import { TelemetryAppInfoAdapter } from './telemetry-app-info.adapter';
import { TelemetryCredentialsAdapter } from './telemetry-credentials.adapter';
import { TelemetryJobsAdapter } from './telemetry-jobs.adapter';
import { TelemetrySettingsStoreAdapter } from './telemetry-settings-store.adapter';

@Module({
  imports: [CredentialsModule],
  providers: [
    { provide: TELEMETRY_AUDIT_SINK, useExisting: AUDIT_SINK },
    { provide: TELEMETRY_SETTINGS_STORE, useClass: TelemetrySettingsStoreAdapter },
    { provide: TELEMETRY_CREDENTIAL_STORE, useClass: TelemetryCredentialsAdapter },
    { provide: TELEMETRY_JOBS, useClass: TelemetryJobsAdapter },
    // PLATFORM-ADOPTION-SHIM(RETRO-E4): the assistant is off until the AI slice carries MemoriaHub's keys.
    { provide: TELEMETRY_AI, useClass: TelemetryAiDisabledAdapter },
    { provide: TELEMETRY_APP_INFO, useClass: TelemetryAppInfoAdapter },
  ],
  exports: [
    TELEMETRY_AUDIT_SINK,
    TELEMETRY_SETTINGS_STORE,
    TELEMETRY_CREDENTIAL_STORE,
    TELEMETRY_JOBS,
    TELEMETRY_AI,
    TELEMETRY_APP_INFO,
  ],
})
export class TelemetryHostModule {}
