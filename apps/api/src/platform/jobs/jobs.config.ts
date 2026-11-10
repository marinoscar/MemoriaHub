// =============================================================================
// The jobs slice's composition (RETRO-C1, #575)
// =============================================================================
//
// `JobsModule.forRoot` is GLOBAL and replaces what this app ran by hand in
// `src/enrichment/`: the enqueue and claim services, the terminal state machine
// (retry, rate-limit deferral, settle), the in-process worker pool and its
// `all|system|off` modes, the lease reaper, the temp-file janitor, the
// job-history purge, the provider throttle and `/api/admin/jobs/*`. It also
// mounts the platform Doctor checks `jobs.worker` and `jobs.backlog`.
//
// What stays is the LEGACY FACE (`enrichment/`): the 38 `EnrichmentHandler`
// classes, wrapped by `platform/jobs/legacy-handlers.adapter.ts`, and
// `EnrichmentJobService.enqueue`, now a facade over `JobsService`
// (`platform/jobs/enrichment-job.facade.ts`). C3 to C8 convert the handlers to
// native `JobHandler`s.
//
// ORDER. `forRoot` registers the `jobs` and `retention` system-settings
// namespaces the slice owns unless the settings manifest already did (it lists
// both: `settings/registry/system-settings.manifest.ts`), and the platform
// refuses a namespace registered after `SettingsModule.forRoot()` composed the
// request bodies. `app.module.ts` therefore imports this file BEFORE
// `platform/settings/settings.config.ts`.
//
// `../../app-registrations/jobs` is imported first so the labels and retired
// types are registered before the application is created (the registries
// freeze when it bootstraps).
// =============================================================================

import '../../app-registrations/jobs';

import { JobsModule } from '@marinoscar/platform-api/jobs';
import { NodesModule } from '@marinoscar/platform-api/nodes';

import { JobsHostModule } from './jobs-host.module';

/** The temp-file prefix is `memoriahub-job-`: the platform janitor sweeps orphans of it. */
export const JOBS_APP_NAME = 'MemoriaHub';

export const jobsModule = JobsModule.forRoot({
  appName: JOBS_APP_NAME,
  imports: [JobsHostModule],
});

// =============================================================================
// The nodes slice (RETRO-C2, #581)
// =============================================================================
//
// `NodesModule.forRoot` is the worker-node fleet: the control plane (`/api/nodes`: register,
// heartbeat, claim, renew, result, failure, telemetry), the data plane (signed URLs through
// `NODE_OBJECT_STORE`, input objects through `NODE_JOB_INPUTS`: both bound in
// `jobs-host.module.ts`), the brokered job secret, `/api/admin/nodes`, and the fleet jobs
// `nodes.fleet.sweep` / `nodes.fleet.prune` with their crons. It replaces `src/nodes/` (the
// controllers, `NodesService`, `NodeCredentialService`, the two fleet crons).
//
// The `nodes` system-settings namespace is registered by the settings manifest, so this module can
// be composed after `SettingsModule.forRoot()`. Environment: `NODE_STALE_OFFLINE_ENABLED` and
// `NODE_OFFLINE_PRUNE_ENABLED` (on unless `false`) switch the two crons off.
//
// `NodeCredentialModule` (the `nod_` token family, global) is imported by `app.module.ts`.
// =============================================================================

export const nodesModule = NodesModule.forRoot({ imports: [JobsHostModule] });
