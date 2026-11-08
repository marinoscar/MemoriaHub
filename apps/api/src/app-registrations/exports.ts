// =============================================================================
// MemoriaHub's export sources (RETRO-H2, #596). Data only.
// =============================================================================
//
// Called by `platform/exports/exports.config.ts` right AFTER `ExportsModule.forRoot` (which
// registers the platform writers and the `user-data` / `org-data` sources first, keeping
// `user-data` the default in the dialog) and before bootstrap freezes the registry.
// Idempotent: a second call (a test that imports the config twice) registers nothing.
// =============================================================================

import { exportSourceRegistry, registerExportSource } from '@marinoscar/platform-api/exports';

import { MEMORIAHUB_EXPORT_SOURCES } from '../platform/exports/memoriahub-export.sources';

export function registerMemoriaHubExportSources(): void {
  for (const source of MEMORIAHUB_EXPORT_SOURCES) {
    if (exportSourceRegistry.get(source.id)) continue;
    registerExportSource(source);
  }
}
