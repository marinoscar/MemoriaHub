import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AcceptLocationSuggestion as AcceptLocationSuggestionDto,
  LocationSuggestionQuery as LocationSuggestionQueryDto,
} from '@marinoscar/memoriahub-contract/location';

import { MediaThumbnailService, enqueueEnrichmentJob } from '../../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubAccessPort,
  type MemoriahubJobsPort,
} from '../../ports/index.js';
import type { LocationDb } from '../data/location-db.js';
import { enqueueGeocodeJob } from '../geo/enqueue-geocode.js';
import { applyLocation } from '../geo/apply-location.util.js';
import { GEO_LOCATION_PROVIDER, type GeoLocationProvider } from '../geo/geo-location-provider.interface.js';
import { GEO_CLEAR_COLUMNS } from '../geo/geo-result.mapper.js';
import { LocationGroupResolverService } from '../groups/location-group-resolver.service.js';

const LocationSuggestionStatus = {
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  auto_applied: 'auto_applied',
  reverted: 'reverted',
} as const;
type LocationSuggestionStatus = (typeof LocationSuggestionStatus)[keyof typeof LocationSuggestionStatus];
const MediaType = { photo: 'photo', video: 'video' } as const;

/**
 * The review queue behind `/api/media/location-suggestions`: list, accept (unmodified or adjusted), reject,
 * revert an auto-applied guess, and force a per-item rerun. Every method checks the caller's role in the
 * owner scope first.
 *
 * @stability experimental
 */
@Injectable()
export class LocationSuggestionService {
  private readonly logger = new Logger(LocationSuggestionService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: LocationDb,
    @Inject(MEMORIAHUB_ACCESS) private readonly membership: MemoriahubAccessPort,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(GEO_LOCATION_PROVIDER) private readonly geoProvider: GeoLocationProvider,
    private readonly mediaThumbnailService: MediaThumbnailService,
    private readonly locationGroupResolver: LocationGroupResolverService,
  ) {}

  private async createAuditEvent(
    actorUserId: string,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'location_suggestion',
        targetId,
        meta: meta,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  /**
   * Lists a circle's suggestions (viewer), newest or most confident first, with signed thumbnails.
   *
   * @param query - the circle, status, paging and sort.
   * @param userId - the caller.
   * @param perms - the caller's permissions.
   */
  async listSuggestions(query: LocationSuggestionQueryDto, userId: string, perms: string[]) {
    const { circleId, status, page, pageSize, mediaItemId } = query;
    // Service specs construct this DTO from a bare object literal (bypassing the
    // Zod pipe), so the schema defaults may not have been applied at runtime.
    const by = query.sortBy ?? 'createdAt';
    const dir = query.sortOrder ?? 'desc';

    await this.membership.requireOwnerRole(userId, circleId, perms, 'viewer');

    const where: Record<string, any> = { circleId, status: status as LocationSuggestionStatus };
    if (mediaItemId) {
      where.mediaItemId = mediaItemId;
    }

    // Both `confidence` and `createdAt` are non-null columns, so the
    // `{ sort, nulls }` object form is not applicable here.
    const orderBy: Array<Record<string, any>> =
      by === 'confidence'
        ? [{ confidence: dir }, { createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: dir }, { id: dir }];

    const [total, suggestions] = await Promise.all([
      this.prisma.locationSuggestion.count({ where }),
      this.prisma.locationSuggestion.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          mediaItem: {
            select: { id: true, capturedAt: true, metadata: true, cameraMake: true, cameraModel: true },
          },
        },
      }),
    ]);

    // Batch-sign all suggestion thumbnails with a single StorageObject query.
    const keyToUrl = await this.mediaThumbnailService.signThumbsBatched(
      suggestions
        .map((s) =>
          this.mediaThumbnailService.extractThumbKey(s.mediaItem?.metadata ?? null),
        )
        .filter((k): k is string => k !== null),
    );

    const items = suggestions.map((s) => {
      const key = this.mediaThumbnailService.extractThumbKey(
        s.mediaItem?.metadata ?? null,
      );
      return {
        id: s.id,
        mediaItemId: s.mediaItemId,
        status: s.status,
        lat: s.lat,
        lng: s.lng,
        confidence: s.confidence,
        method: s.method,
        anchorBeforeId: s.anchorBeforeId,
        anchorAfterId: s.anchorAfterId,
        gapBeforeSeconds: s.gapBeforeSeconds,
        gapAfterSeconds: s.gapAfterSeconds,
        anchorDistanceKm: s.anchorDistanceKm,
        impliedSpeedKmh: s.impliedSpeedKmh,
        capturedAt: s.mediaItem?.capturedAt ?? null,
        cameraMake: s.mediaItem?.cameraMake ?? null,
        cameraModel: s.mediaItem?.cameraModel ?? null,
        thumbnailUrl: key ? keyToUrl.get(key) ?? null : null,
      };
    });

    return {
      items,
      meta: { total, page, pageSize },
    };
  }

  // ---------------------------------------------------------------------------
  // Accept
  // ---------------------------------------------------------------------------

  /**
   * Accepts a pending suggestion (editor): unmodified keeps `coordSource` `inferred`, adjusted becomes `manual`.
   *
   * @param id - the suggestion.
   * @param dto - optional adjusted coordinates.
   * @param userId - the caller.
   * @param perms - the caller's permissions.
   */
  async acceptSuggestion(id: string, dto: AcceptLocationSuggestionDto, userId: string, perms: string[]) {
    const suggestion = await this.prisma.locationSuggestion.findUnique({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException(`Location suggestion ${id} not found`);
    }

    await this.membership.requireOwnerRole(userId, suggestion.circleId, perms, 'editor');

    if (suggestion.status !== LocationSuggestionStatus.pending) {
      throw new BadRequestException(
        `Location suggestion ${id} is not pending (current: ${suggestion.status})`,
      );
    }

    const useLat = dto.lat ?? suggestion.lat;
    const useLng = dto.lng ?? suggestion.lng;
    // Unmodified (no lat/lng, or equal to the stored suggestion) -> 'inferred';
    // adjusted by the caller -> 'manual'.
    const adjusted = useLat !== suggestion.lat || useLng !== suggestion.lng;
    const coordSource = adjusted ? 'manual' : 'inferred';

    const patch = await applyLocation(
      this.geoProvider,
      useLat,
      useLng,
      null,
      coordSource,
      this.locationGroupResolver,
    );

    await this.prisma.$transaction([
      this.prisma.mediaItem.update({ where: { id: suggestion.mediaItemId }, data: patch }),
      this.prisma.locationSuggestion.update({
        where: { id },
        data: { status: LocationSuggestionStatus.accepted, resolvedById: userId, resolvedAt: new Date() },
      }),
    ]);

    await this.createAuditEvent(userId, 'location_suggestion:accepted', id, {
      lat: useLat,
      lng: useLng,
      adjusted,
      coordSource,
    });

    this.logger.log(`Location suggestion ${id} accepted by user ${userId} (adjusted=${adjusted})`);

    return { data: { id, status: 'accepted', lat: useLat, lng: useLng, coordSource } };
  }

  // ---------------------------------------------------------------------------
  // Reject
  // ---------------------------------------------------------------------------

  /**
   * Rejects a pending suggestion (editor); a rejection is sticky against non-forced recomputes.
   *
   * @param id - the suggestion.
   * @param userId - the caller.
   * @param perms - the caller's permissions.
   */
  async rejectSuggestion(id: string, userId: string, perms: string[]) {
    const suggestion = await this.prisma.locationSuggestion.findUnique({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException(`Location suggestion ${id} not found`);
    }

    await this.membership.requireOwnerRole(userId, suggestion.circleId, perms, 'editor');

    if (suggestion.status !== LocationSuggestionStatus.pending) {
      throw new BadRequestException(
        `Location suggestion ${id} is not pending (current: ${suggestion.status})`,
      );
    }

    await this.prisma.locationSuggestion.update({
      where: { id },
      data: { status: LocationSuggestionStatus.rejected, resolvedById: userId, resolvedAt: new Date() },
    });

    await this.createAuditEvent(userId, 'location_suggestion:rejected', id, {});

    this.logger.log(`Location suggestion ${id} rejected by user ${userId}`);

    return { data: { id, status: 'rejected' } };
  }

  // ---------------------------------------------------------------------------
  // Revert
  // ---------------------------------------------------------------------------

  /**
   * Reverts an auto-applied suggestion (editor): clears the coordinates and every derived geo column.
   *
   * @param id - the suggestion.
   * @param userId - the caller.
   * @param perms - the caller's permissions.
   */
  async revertSuggestion(id: string, userId: string, perms: string[]) {
    const suggestion = await this.prisma.locationSuggestion.findUnique({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException(`Location suggestion ${id} not found`);
    }

    await this.membership.requireOwnerRole(userId, suggestion.circleId, perms, 'editor');

    if (suggestion.status !== LocationSuggestionStatus.auto_applied) {
      throw new BadRequestException(
        `Location suggestion ${id} is not auto_applied (current: ${suggestion.status})`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.mediaItem.update({
        where: { id: suggestion.mediaItemId },
        data: { ...GEO_CLEAR_COLUMNS },
      }),
      this.prisma.locationSuggestion.update({
        where: { id },
        data: { status: LocationSuggestionStatus.reverted, resolvedById: userId, resolvedAt: new Date() },
      }),
    ]);

    await this.createAuditEvent(userId, 'location_suggestion:reverted', id, {});

    this.logger.log(`Location suggestion ${id} reverted by user ${userId}`);

    return { data: { id, status: 'reverted' } };
  }

  // ---------------------------------------------------------------------------
  // Per-item rerun (forced — bypasses the rejected-skip rule)
  // ---------------------------------------------------------------------------

  /**
   * Queues a forced inference rerun for one photo (editor) that bypasses the rejected-suggestion skip.
   *
   * @param mediaItemId - the photo.
   * @param userId - the caller.
   * @param perms - the caller's permissions.
   */
  async inferLocation(mediaItemId: string, userId: string, perms: string[]) {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true, type: true },
    });

    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    // MANDATORY per-circle collaborator check, performed BEFORE any other
    // logic — mirrors the fix applied to the duplicate-detection rerun
    // endpoint (commit 6ec95e6), which originally only checked the
    // system-level media:write permission and skipped this check.
    await this.membership.requireOwnerRole(userId, mediaItem.circleId, perms, 'editor');

    if (mediaItem.type !== MediaType.photo) {
      throw new BadRequestException('Location inference only applies to photos');
    }

    const { id: jobId } = await enqueueEnrichmentJob(this.jobs, {
      type: 'location_inference',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: 'rerun',
      priority: 0,
    });
    const jobRow = await this.prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    const job = { id: jobId, status: (jobRow?.status as string | undefined) ?? 'pending' };

    this.logger.log(
      `Location-inference rerun job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${userId}`,
    );

    return { data: { jobId: job.id, status: job.status } };
  }
}
