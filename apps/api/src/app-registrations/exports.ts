// =============================================================================
// MemoriaHub's export sources (RETRO-H2, #596). Data only.
// =============================================================================
//
// Called by `platform/exports/exports.config.ts` right AFTER `ExportsModule.forRoot` (which
// registers the platform writers) and before bootstrap freezes the registry. In dialog order:
//
//   user-data, org-data   the platform's sources under their permanent ids, with MemoriaHub's
//                         extra redaction (`memoriahub-platform-sources.ts`,
//                         PLATFORM-ADOPTION-SHIM(#596)); `forRoot` registers neither
//                         (`platformSources` off). `user-data` stays first: the dialog default.
//   memoriahub-*          MemoriaHub's four sources.
//
// Idempotent: a second call (a test that imports the config twice) registers nothing.
// =============================================================================

import { exportSourceRegistry, registerExportSource } from '@marinoscar/platform-api/exports';

import { MEMORIAHUB_EXPORT_SOURCES } from '../platform/exports/memoriahub-export.sources';
import {
  MEMORIAHUB_ORG_DATA_EXPORT_SOURCE,
  MEMORIAHUB_USER_DATA_EXPORT_SOURCE,
} from '../platform/exports/memoriahub-platform-sources';

/** Every source this app registers, in dialog order. */
export const MEMORIAHUB_REGISTERED_EXPORT_SOURCES = [
  MEMORIAHUB_USER_DATA_EXPORT_SOURCE,
  MEMORIAHUB_ORG_DATA_EXPORT_SOURCE,
  ...MEMORIAHUB_EXPORT_SOURCES,
] as const;

export function registerMemoriaHubExportSources(): void {
  for (const source of MEMORIAHUB_REGISTERED_EXPORT_SOURCES) {
    if (exportSourceRegistry.get(source.id)) continue;
    registerExportSource(source as Parameters<typeof registerExportSource>[0]);
  }
}
