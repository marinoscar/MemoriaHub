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
// This module imports the domain modules whose services the checks read. Android
// checks read `media_sync_devices` through the global PrismaModule;
// `MediaSyncModule` is deliberately NOT imported. Nothing imports this module
// except `AppModule`, so it closes no cycle.
//
// The platform ships `db.connection`, `db.migrations`, `secrets.encryption-key`
// (retiring `core.database`, `core.migrations`, `core.secretsKey`) and more with
// `PlatformHostCoreModule`.
// =============================================================================

import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AndroidAppModule } from '../android-app/android-app.module';
import { DedupModule } from '../dedup/dedup.module';
import { FaceModule } from '../face/face.module';
import { GeoModule } from '../geo/geo.module';
import { SocialMediaModule } from '../social-media/social-media.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';

import { AdminBootstrapDoctorCheck } from './checks/auth/admin-bootstrap.doctor-check';
import { GoogleOauthDoctorCheck } from './checks/auth/google-oauth.doctor-check';
import { JwtDoctorCheck } from './checks/auth/jwt.doctor-check';
import { AiEmbeddingDoctorCheck } from './checks/ai/embedding.doctor-check';
import { AiFlagConsistencyDoctorCheck } from './checks/ai/flag-consistency.doctor-check';
import { AiSearchDoctorCheck } from './checks/ai/search.doctor-check';
import { AiTaggingDoctorCheck } from './checks/ai/tagging.doctor-check';
import { DuplicateDetectionDoctorCheck } from './checks/ai/duplicate-detection.doctor-check';
import { PictureEnhancerDoctorCheck } from './checks/ai/picture-enhancer.doctor-check';
import { SocialMediaDoctorCheck } from './checks/ai/social-media.doctor-check';
import { VideoTaggingDoctorCheck } from './checks/ai/video-tagging.doctor-check';
import { AndroidAssetLinksDoctorCheck } from './checks/android/assetlinks.doctor-check';
import { AndroidMediaSyncDoctorCheck } from './checks/android/media-sync.doctor-check';
import { AndroidReleasesDoctorCheck } from './checks/android/releases.doctor-check';
import { AndroidUploadPathDoctorCheck } from './checks/android/upload-path.doctor-check';
import { AppUrlDoctorCheck } from './checks/core/app-url.doctor-check';
import { PgvectorDoctorCheck } from './checks/core/pgvector.doctor-check';
import { FaceDetectionDoctorCheck } from './checks/face/detection.doctor-check';
import { FaceFlagConsistencyDoctorCheck } from './checks/face/flag-consistency.doctor-check';
import { FacePgvectorDoctorCheck } from './checks/face/pgvector.doctor-check';
import { GeoReverseProviderDoctorCheck } from './checks/geo/reverse-provider.doctor-check';
import { BurstConfigDoctorCheck } from './checks/jobs/burst-config.doctor-check';
import { NodesCapabilityHealthDoctorCheck } from './checks/nodes/capability-health.doctor-check';
import { NodesHeartbeatDoctorCheck } from './checks/nodes/heartbeat-freshness.doctor-check';
import { NodesRegisteredDoctorCheck } from './checks/nodes/registered-count.doctor-check';
import { NodesStaleLeasesDoctorCheck } from './checks/nodes/stale-leases.doctor-check';
import { WorkflowsStateDoctorCheck } from './checks/workflows/state.doctor-check';

/**
 * The 29 `memoriahub.*` checks: the 35 documented ones minus the 3 the host core retired, the 2 the
 * jobs slice retired (RETRO-C1) and `core.pg-client-version`, which the db-backup slice's
 * `backup.pg-client` replaced (RETRO-D4).
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
  // ai
  AiSearchDoctorCheck,
  AiTaggingDoctorCheck,
  AiEmbeddingDoctorCheck,
  AiFlagConsistencyDoctorCheck,
  SocialMediaDoctorCheck,
  DuplicateDetectionDoctorCheck,
  PictureEnhancerDoctorCheck,
  VideoTaggingDoctorCheck,
  // face
  FaceDetectionDoctorCheck,
  FaceFlagConsistencyDoctorCheck,
  FacePgvectorDoctorCheck,
  // geo
  GeoReverseProviderDoctorCheck,
  // jobs
  BurstConfigDoctorCheck,
  // nodes
  NodesRegisteredDoctorCheck,
  NodesHeartbeatDoctorCheck,
  NodesStaleLeasesDoctorCheck,
  NodesCapabilityHealthDoctorCheck,
  // workflows
  WorkflowsStateDoctorCheck,
  // android
  AndroidAssetLinksDoctorCheck,
  AndroidReleasesDoctorCheck,
  AndroidMediaSyncDoctorCheck,
  AndroidUploadPathDoctorCheck,
];

@Module({
  imports: [
    
    AiModule,
    FaceModule,
    GeoModule,
    MediaProcessingModule,
    SocialMediaModule,
    DedupModule,
    AndroidAppModule,
  ],
  providers: MEMORIAHUB_DOCTOR_CHECKS,
})
export class DoctorChecksModule {}
