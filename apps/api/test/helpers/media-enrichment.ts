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
import { registerFaceUploadEnrichment } from '../../src/face/face-upload-enrichment';
import { registerLocationInferenceUploadEnrichment } from '../../src/location-inference/location-inference-upload-enrichment';
import { MediaEnrichmentService } from '../../src/media/enrichment/media-enrichment.service';
import { AppSystemSettingsService } from '../../src/platform/settings/app-system-settings.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { registerSocialMediaUploadEnrichment } from '../../src/social-media/social-media-upload-enrichment';
import { registerTaggingUploadEnrichment } from '@marinoscar/memoriahub-api/tagging';

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

  // The tagging slice enqueues through the jobs port; the fan-out specs read the legacy facade's calls,
  // so the port's input is translated back to them (the subject is the media item, the circle rides in the payload).
  const taggingJobsPort = {
    enqueue: async (input: { type: string; reason?: string; subjectId?: string; payload: Record<string, unknown>; priority?: number }) => {
      const job = await jobs.enqueue({
        type: input.type,
        mediaItemId: input.subjectId ?? null,
        circleId: (input.payload['circleId'] as string | undefined) ?? null,
        reason: input.reason as JobReason,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      });
      return { id: job.id, deduplicated: false };
    },
  };
  registerTaggingUploadEnrichment(registry, taggingJobsPort as never, prisma as never);
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
