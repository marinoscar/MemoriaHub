// =============================================================================
// MemoriaHub's Doctor checks (RETRO-B1b, #602)
// =============================================================================
//
// Each check registers itself with the platform `DoctorCheckRegistry` in its
// own `onModuleInit` (the registry is global, provided by
// `DoctorModule.forRoot`, see `./doctor.config.ts`), so being in the module
// graph IS the registration. The checks are READ-ONLY (`docs/specs/doctor.md`),
// with the live provider probes listed in
// `docs/platform-adoption/local-exceptions.md`.
//
// The checks a domain slice owns (RETRO-J10, #624) are the slice's: they register through the
// `MEMORIAHUB_DOCTOR` port from their slice's `forRoot` providers (see `SLICE_DOCTOR_CHECKS`), bound to
// the platform registry by `PlatformMemoriahubDoctorAdapter`. What stays here is what has no slice to
// own it (core, auth, nodes), what needs a platform service (nothing since RETRO-J10: the AI probes are the
// slices', over the `MEMORIAHUB_AI_ADMIN` port). Nothing imports this module except
// `AppModule`, so it closes no cycle.
//
// The platform ships `db.connection`, `db.migrations`, `secrets.encryption-key`
// (retiring `core.database`, `core.migrations`, `core.secretsKey`) and more with
// `PlatformHostCoreModule`.
// =============================================================================

import { Module } from '@nestjs/common';
import { AiPortModule } from '../ai-port/ai-port.module';
import { DedupModule } from '../dedup/dedup.module';
import { FaceModule } from '../face/face.module';
import { GeoModule } from '../geo/geo.module';
import { SocialMediaModule } from '../social-media/social-media.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';

import { AndroidMediaSyncDoctorCheck, AndroidUploadPathDoctorCheck } from '@marinoscar/memoriahub-api/media';
import { DuplicateDetectionDoctorCheck } from '@marinoscar/memoriahub-api/dedup';
import { BurstConfigDoctorCheck } from '@marinoscar/memoriahub-api/burst';
import { SocialMediaDoctorCheck } from '@marinoscar/memoriahub-api/social-media';
import {
  FaceDetectionDoctorCheck,
  FaceFlagConsistencyDoctorCheck,
  FacePgvectorDoctorCheck,
} from '@marinoscar/memoriahub-api/face';
import { GeoReverseProviderDoctorCheck } from '@marinoscar/memoriahub-api/location';
import { WorkflowsStateDoctorCheck } from '@marinoscar/memoriahub-api/workflows';
import { AiFlagConsistencyDoctorCheck, AiTaggingDoctorCheck, VideoTaggingDoctorCheck } from '@marinoscar/memoriahub-api/tagging';
import { AiEmbeddingDoctorCheck, AiSearchDoctorCheck } from '@marinoscar/memoriahub-api/search';
import { PictureEnhancerDoctorCheck } from '@marinoscar/memoriahub-api/enhancement';

import { AdminBootstrapDoctorCheck } from './checks/auth/admin-bootstrap.doctor-check';
import { GoogleOauthDoctorCheck } from './checks/auth/google-oauth.doctor-check';
import { JwtDoctorCheck } from './checks/auth/jwt.doctor-check';
import { AppUrlDoctorCheck } from './checks/core/app-url.doctor-check';
import { PgvectorDoctorCheck } from './checks/core/pgvector.doctor-check';
import { NodesCapabilityHealthDoctorCheck } from './checks/nodes/capability-health.doctor-check';
import { NodesHeartbeatDoctorCheck } from './checks/nodes/heartbeat-freshness.doctor-check';
import { NodesRegisteredDoctorCheck } from './checks/nodes/registered-count.doctor-check';
import { NodesStaleLeasesDoctorCheck } from './checks/nodes/stale-leases.doctor-check';

/**
 * The `memoriahub.*` checks: the 35 documented ones minus the 3 the host core retired, the 2 the
 * jobs slice retired (RETRO-C1), `core.pg-client-version`, which the db-backup slice's
 * `backup.pg-client` replaced (RETRO-D4), the two storage checks (RETRO-D1) and
 * `android.assetlinks` / `android.releases`, which the android-app slice ships (RETRO-D5).
 */
export const MEMORIAHUB_DOCTOR_CHECKS = [
  // core
  PgvectorDoctorCheck,
  AppUrlDoctorCheck,
  // auth
  JwtDoctorCheck,
  GoogleOauthDoctorCheck,
  AdminBootstrapDoctorCheck,
  // storage
  // ai (the slices' since RETRO-J10, over the `MEMORIAHUB_AI_ADMIN` port)
  // face
  // geo
  // jobs
  // nodes
  NodesRegisteredDoctorCheck,
  NodesHeartbeatDoctorCheck,
  NodesStaleLeasesDoctorCheck,
  NodesCapabilityHealthDoctorCheck,
  // workflows
  // android (`android.assetlinks` and `android.releases` are the android-app slice's since
  // RETRO-D5; `android.media-sync` and `android.upload-path` are the media slice's since RETRO-J10)
];

/**
 * The checks the domain slices own and register themselves (through `MEMORIAHUB_DOCTOR`, from their `forRoot`
 * providers): listed here for the inventory, and for the specs that run the whole set. NOT providers of this
 * module (a second registration would throw as a duplicate id).
 */
export const SLICE_DOCTOR_CHECKS = [
  // ai
  AiFlagConsistencyDoctorCheck,
  AiSearchDoctorCheck,
  AiTaggingDoctorCheck,
  AiEmbeddingDoctorCheck,
  PictureEnhancerDoctorCheck,
  VideoTaggingDoctorCheck,
  SocialMediaDoctorCheck,
  DuplicateDetectionDoctorCheck,
  // face
  FaceDetectionDoctorCheck,
  FaceFlagConsistencyDoctorCheck,
  FacePgvectorDoctorCheck,
  // geo
  GeoReverseProviderDoctorCheck,
  // jobs
  BurstConfigDoctorCheck,
  // workflows
  WorkflowsStateDoctorCheck,
  // android
  AndroidMediaSyncDoctorCheck,
  AndroidUploadPathDoctorCheck,
];

/** Every `memoriahub.*` check of the application, the slices' and this module's. */
export const ALL_MEMORIAHUB_DOCTOR_CHECKS = [...SLICE_DOCTOR_CHECKS, ...MEMORIAHUB_DOCTOR_CHECKS];

@Module({
  imports: [
    AiPortModule,
    // The slices' own checks no longer need these modules' services, but the OpenAPI document follows the
    // module graph's discovery order, which these edges set: dropping them moves the routes of these four
    // modules in the document (it is byte-identical to the one before RETRO-J10 with them).
    FaceModule,
    GeoModule,
    MediaProcessingModule,
    SocialMediaModule,
    DedupModule,
  ],
  providers: MEMORIAHUB_DOCTOR_CHECKS,
})
export class DoctorChecksModule {}
