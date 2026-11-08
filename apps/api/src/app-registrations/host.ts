// =============================================================================
// This app's host registrations (RETRO-B1, #597)
// =============================================================================
//
// What MemoriaHub adds to the platform's host slice through its registries:
//
//   * an About group "Enrichment" (how this process claims queue work and which
//     face-vector backend it matches against).
//
// MAINTENANCE BYPASSES: none. The routes reachable during a window
// (`/api/health/*`, the sign-in routes of `auth.controller.ts` and
// `/api/well-known/assetlinks.json`) carry the platform's
// `@AllowDuringMaintenance()` on the handler or class, which is the same
// metadata key the old decorator used. Add `registerMaintenanceBypass` here
// only for a route that cannot carry a decorator.
//
// HEALTH INDICATORS: none beyond the built-in `database` one. CompreFace and
// the CLIP model are optional sidecars/degradable features; keeping them out of
// readiness is deliberate (a missing sidecar must not drain the instance).
//
// IMPORTED BY `platform/host-core.config.ts`, so it runs before the application
// is created (the registries freeze when it bootstraps). An About contributor's
// `describe()` takes no arguments and cannot inject a service, so this one
// reads only non-secret environment values.
// =============================================================================

import { registerAboutContributor } from '@marinoscar/platform-api/host';

import { configuredWorkerMode } from '../platform/jobs/legacy-env';

/** The "Enrichment" group: plain, non-secret process facts. */
export function describeEnrichment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const workerMode = configuredWorkerMode(env);
  return {
    workerMode,
    faceVectorBackend: env.FACE_VECTOR_BACKEND ?? 'pgvector',
  };
}

registerAboutContributor({
  id: 'enrichment',
  label: 'Enrichment',
  describe: () => describeEnrichment(),
});
