/**
 * Unit tests for SocialController.
 *
 * Focus: social media detection is a VIDEO-ONLY check. The rerun endpoint must
 * reject photos with a 400 and never enqueue a job for them.
 *
 * All external dependencies are mocked — no real DB.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaType, MediaSocialStatusType } from '@prisma/client';
import { SocialController } from './social.controller';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

const user: RequestUser = {
  id: 'user-1',
  permissions: ['media:write', 'media:read'],
} as unknown as RequestUser;

function buildController() {
  const prisma = {
    mediaItem: { findUnique: jest.fn() },
    mediaSocialStatus: { upsert: jest.fn().mockResolvedValue({}) },
  } as unknown as jest.Mocked<PrismaService>;

  const membership = {
    assertCircleAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<CircleMembershipService>;

  const enrichment = {
    enqueue: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }),
  } as unknown as jest.Mocked<EnrichmentJobService>;

  const controller = new SocialController(prisma, membership, enrichment);
  return { controller, prisma, membership, enrichment };
}

describe('SocialController.rerunSocialDetection', () => {
  it('rejects a photo with BadRequestException and does NOT enqueue a job', async () => {
    const { controller, prisma, enrichment } = buildController();
    (prisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
      id: 'media-photo',
      circleId: 'circle-1',
      type: MediaType.photo,
      deletedAt: null,
    });

    await expect(
      controller.rerunSocialDetection('media-photo', user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(enrichment.enqueue).not.toHaveBeenCalled();
    expect(prisma.mediaSocialStatus.upsert).not.toHaveBeenCalled();
  });

  it('enqueues a social_media_detection job for a video', async () => {
    const { controller, prisma, enrichment } = buildController();
    (prisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
      id: 'media-video',
      circleId: 'circle-1',
      type: MediaType.video,
      deletedAt: null,
    });

    const result = await controller.rerunSocialDetection('media-video', user);

    expect(enrichment.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'social_media_detection', mediaItemId: 'media-video' }),
    );
    expect(prisma.mediaSocialStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mediaItemId: 'media-video' },
        update: { status: MediaSocialStatusType.pending },
      }),
    );
    expect(result).toEqual({ data: { jobId: 'job-1', status: 'pending' } });
  });

  it('throws NotFoundException for a missing/deleted item', async () => {
    const { controller, prisma } = buildController();
    (prisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      controller.rerunSocialDetection('missing', user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
