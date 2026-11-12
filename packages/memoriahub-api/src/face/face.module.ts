import { Module, type DynamicModule, type ModuleMetadata, type Provider } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { FaceAutoArchiveSweepHandler } from './face-auto-archive-sweep.handler.js';
import { FaceBackfillService } from './face-backfill.service.js';
import { FaceClusteringService } from './face-clustering.service.js';
import { FaceDetectionCore } from './face-detection-core.service.js';
import { FaceDetectionHandler } from './face-detection.handler.js';
import { FaceDetectionService } from './face-detection.service.js';
import { FaceMatchingService } from './face-matching.service.js';
import { FaceSettingsService } from './face-settings.service.js';
import { FaceUploadEnrichment } from './face-upload-enrichment.js';
import { FaceDetectionDoctorCheck } from './doctor/detection.doctor-check.js';
import { FaceFlagConsistencyDoctorCheck } from './doctor/flag-consistency.doctor-check.js';
import { FacePgvectorDoctorCheck } from './doctor/pgvector.doctor-check.js';
import { FACE_CONFIG } from './host/face-config.js';
import { FaceJobs } from './host/face-jobs.js';
import { FaceSystemSettings } from './host/face-system-settings.js';
import { FACE_OPTIONS, type FaceModuleOptions } from './host/face-options.js';
import { PeopleService } from './people.service.js';
import { FaceProviderRegistry } from './providers/face-provider.registry.js';
import { VideoFaceDetectionHandler } from './video-face-detection.handler.js';
import { VideoFaceDetectionService } from './video-face-detection.service.js';
import { VideoFrameExtractionService } from './video-frame-extraction.service.js';

/**
 * Options of {@link FaceModule.forRoot}.
 *
 * @stability experimental
 */
export interface FaceModuleForRootOptions extends FaceModuleOptions {
  /**
   * Providers the host supplies for the tokens the slice injects and that are not ports:
   * `FACE_CONFIG` (the configuration reader), `FACE_PERSON_AVATARS` (the account-avatar code) and
   * `FACE_STORAGE_ORG` (the organization of a derived storage row).
   */
  providers: Provider[];
  /** Modules the host's providers need. */
  imports?: ModuleMetadata['imports'];
}

/**
 * The face slice (RETRO-J6, #615): detection of faces in photos and videos, matching against people,
 * clustering, people management and auto-archive. It reaches the outside only through the ports of
 * `@marinoscar/memoriahub-api/ports` and the three host tokens of {@link FaceModuleForRootOptions}.
 * The HTTP controllers are the host's: they import the services this module exports.
 *
 * Import it ONCE in the host. The three job handlers (`face_detection`, `video_face_detection`,
 * `face_auto_archive_sweep`) register themselves with the queue on start; the photo upload fan-out
 * registers with the media slice.
 *
 * @stability experimental
 */
@Module({})
export class FaceModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module. The result is cached, so every `forRoot()` call names the same module instance.
   *
   * @param options - the host's providers and the options of the slice.
   */
  static forRoot(options: FaceModuleForRootOptions): DynamicModule {
    const { providers: hostProviders, imports = [], ...rest } = options;
    FaceModule.root ??= {
      module: FaceModule,
      imports: [MediaModule.forRoot(), ...imports],
      providers: [
        ...hostProviders,
        { provide: FACE_OPTIONS, useValue: rest satisfies FaceModuleOptions },
        FaceJobs,
        FaceSystemSettings,
        FaceUploadEnrichment,
        FaceSettingsService,
        FaceProviderRegistry,
        FaceDetectionCore,
        FaceDetectionService,
        FaceMatchingService,
        FaceClusteringService,
        PeopleService,
        FaceDetectionHandler,
        FaceBackfillService,
        VideoFrameExtractionService,
        VideoFaceDetectionService,
        VideoFaceDetectionHandler,
        FaceAutoArchiveSweepHandler,
        FaceDetectionDoctorCheck,
        FaceFlagConsistencyDoctorCheck,
        FacePgvectorDoctorCheck,
      ],
      exports: [
        FACE_CONFIG,
        FaceJobs,
        FaceSystemSettings,
        FaceSettingsService,
        FaceProviderRegistry,
        FaceMatchingService,
        FaceClusteringService,
        VideoFrameExtractionService,
        PeopleService,
        FaceDetectionService,
        FaceBackfillService,
      ],
    };
    return FaceModule.root;
  }
}
