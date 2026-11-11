import { Injectable } from '@nestjs/common';
import type { SocialMediaPostDetection } from '@marinoscar/memoriahub-api/social-media';
import { JobReason, type MediaType } from '@prisma/client';

import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';

/**
 * The web app's binding of the social-media slice's `SOCIAL_MEDIA_POST_DETECTION` hook: the video fan-out
 * withheld while a video was being classified (face detection, video tagging) is the media enrichment
 * service's, which owns their gates.
 */
@Injectable()
export class SocialMediaPostDetectionAdapter implements SocialMediaPostDetection {
  constructor(private readonly mediaEnrichment: MediaEnrichmentService) {}

  /** Enqueues the withheld video enrichment for one item. */
  enqueueVideoPostDetectionEnrichment(
    item: { id: string; type: string; circleId: string; deletedAt: Date | null },
    reason: string,
  ): Promise<void> {
    const jobReason = reason === JobReason.rerun || reason === JobReason.backfill ? (reason as JobReason) : JobReason.upload;
    return this.mediaEnrichment.enqueueVideoPostDetectionEnrichment({ ...item, type: item.type as MediaType }, jobReason);
  }
}
