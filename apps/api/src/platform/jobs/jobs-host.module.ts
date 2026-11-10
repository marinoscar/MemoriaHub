// =============================================================================
// The jobs slice's host ports (RETRO-C1, #575)
// =============================================================================
//
//   JOBS_EVENT_BUS  -> EVENT_BUS          (the host core's cross-replica bus; the
//                                          `jobs.enqueued` wake-up rides it)
//   JOBS_METRICS    -> AppMetricsService  (the host core's `app.jobs.*` instruments;
//                                          the port has no parameter for an
//                                          organization, so `org.id` is never a label)
//   JOBS_ORG_SCOPE  -> no ambient org     (single-organization mode: every enqueue
//                                          passes `orgId` explicitly, and an
//                                          explicit null is never replaced)
//
// And the nodes slice's two ports (RETRO-C2, #581):
//
//   NODE_OBJECT_STORE -> STORAGE_PROVIDER (the storage slice's ready-made binding: the signed
//                                          GET and PUT of the data plane)
//   NODE_JOB_INPUTS   -> NodeJobInputsAdapter (a media-item job reads its item's StorageObject)
//
// `@Global()` so the slice's services resolve the ports from whichever module
// instantiates them.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { AppMetricsService, EVENT_BUS } from '@marinoscar/platform-api/host';
import { JOBS_EVENT_BUS, JOBS_METRICS, JOBS_ORG_SCOPE, type JobsOrgScope } from '@marinoscar/platform-api/jobs';
import { NODE_JOB_INPUTS } from '@marinoscar/platform-api/nodes';
import { StorageProvidersModule, nodeObjectStoreBinding } from '@marinoscar/platform-api/storage';

import { NodeJobInputsAdapter } from './node-job-inputs.adapter';

const NO_AMBIENT_ORG: JobsOrgScope = { currentOrgId: () => null };

const BINDINGS = [
  { provide: JOBS_EVENT_BUS, useExisting: EVENT_BUS },
  { provide: JOBS_METRICS, useExisting: AppMetricsService },
  { provide: JOBS_ORG_SCOPE, useValue: NO_AMBIENT_ORG },
  nodeObjectStoreBinding,
  { provide: NODE_JOB_INPUTS, useClass: NodeJobInputsAdapter },
];

@Global()
@Module({
  imports: [StorageProvidersModule],
  providers: BINDINGS,
  exports: BINDINGS.map((binding) => binding.provide),
})
export class JobsHostModule {}
