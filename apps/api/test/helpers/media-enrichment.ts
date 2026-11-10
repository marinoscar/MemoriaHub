// =============================================================================
// A real `MediaEnrichmentService` over mocked collaborators (RETRO-J5, #613)
// =============================================================================
//
// The upload fan-out is the media slice's `UploadEnrichmentRegistry`; each slice
// registers its own enqueue (`registerTaggingUploadEnrichment`, ...). A spec of the
// fan-out as a whole needs all six registered, in front of the same mocks the
// service always had: the Prisma client, `EnrichmentJobService` and the settings
// service. `mediaEnrichmentProvider` is the Nest provider for it.
// =============================================================================

import { JobReason } from '@prisma/client';
import { UploadEnrichmentRegistry, UploadEnrichmentService } from '@marinoscar/memoriahub-api/media';

import { registerBurstUploadEnrichment } from '../../src/burst/burst-upload-enrichment';
import { registerDedupUploadEnrichment } from '../../src/dedup/dedup-upload-enrichment';
import { EnrichmentJobService } from '../../src/enrichment/enrichment-job.service';
import { registerFaceUploadEnrichment } from '@marinoscar/memoriahub-api/face';
import { registerLocationInferenceUploadEnrichment } from '../../src/location-inference/location-inference-upload-enrichment';
import { MediaEnrichmentService } from '../../src/media/enrichment/media-enrichment.service';
import { AppSystemSettingsService } from '../../src/platform/settings/app-system-settings.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { registerSocialMediaUploadEnrichment } from '../../src/social-media/social-media-upload-enrichment';
import { registerTaggingUploadEnrichment } from '../../src/tagging/tagging-upload-enrichment';

/** Builds the service with every slice's upload fan-out registered, over the given collaborators. */
export function buildMediaEnrichment(
  prisma: PrismaService,
  jobs: EnrichmentJobService,
  systemSettings: AppSystemSettingsService,
): MediaEnrichmentService {
  // The settings port, over the (mocked) cached settings document.
  const settingsPort = {
    readSystem: async (name: string) => ({
      value: ((await systemSettings.getSettings()) as unknown as Record<string, unknown>)[name],
      version: 1,
    }),
  };

  const registry = new UploadEnrichmentRegistry();
  const service = new MediaEnrichmentService(
    prisma,
    jobs,
    systemSettings,
    new UploadEnrichmentService(registry, settingsPort as never),
  );

  registerTaggingUploadEnrichment(registry, jobs, prisma);
  registerFaceUploadEnrichment(registry, jobs, prisma);
  registerSocialMediaUploadEnrichment(registry, jobs, prisma, (item) =>
    service.enqueueVideoPostDetectionEnrichment(item as never, JobReason.upload),
  );
  registerBurstUploadEnrichment(registry, jobs);
  registerDedupUploadEnrichment(registry, jobs);
  registerLocationInferenceUploadEnrichment(registry, jobs);
  return service;
}

/** The Nest provider of {@link buildMediaEnrichment}, for `Test.createTestingModule({ providers: [...] })`. */
export const mediaEnrichmentProvider = {
  provide: MediaEnrichmentService,
  useFactory: (prisma: PrismaService, jobs: EnrichmentJobService, systemSettings: AppSystemSettingsService) =>
    buildMediaEnrichment(prisma, jobs, systemSettings),
  inject: [PrismaService, EnrichmentJobService, AppSystemSettingsService],
};
