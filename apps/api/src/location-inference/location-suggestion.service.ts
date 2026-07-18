import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CircleRole, JobReason, JobStatus, LocationSuggestionStatus, MediaType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { STORAGE_PROVIDER, StorageProvider } from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { GEO_LOCATION_PROVIDER, GeoLocationProvider } from '../media/geo/geo-location-provider.interface';
import { applyLocation } from '../media/geo/apply-location.util';
import { GEO_CLEAR_COLUMNS } from '../media/geo/geo-result.mapper';
import { LocationSuggestionQueryDto } from './dto/location-suggestion-query.dto';
import { AcceptLocationSuggestionDto } from './dto/accept-location-suggestion.dto';
import { BulkAcceptLocationSuggestionsDto } from './dto/bulk-accept-location-suggestions.dto';

@Injectable()
export class LocationSuggestionService {
  private readonly logger = new Logger(LocationSuggestionService.name);

  /** Pending suggestions drained per DB page by processBulkAccept (bounds memory). */
  private static readonly BULK_ACCEPT_BATCH_SIZE = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly resolver: StorageProviderResolver,
    @Inject(GEO_LOCATION_PROVIDER) private readonly geoProvider: GeoLocationProvider,
    private readonly mediaThumbnailService: MediaThumbnailService,
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
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  async listSuggestions(query: LocationSuggestionQueryDto, userId: string, perms: string[]) {
    const { circleId, status, page, pageSize, mediaItemId } = query;

    await this.membership.assertCircleAccess(userId, circleId, perms, CircleRole.viewer);

    const where: Prisma.LocationSuggestionWhereInput = { circleId, status: status as LocationSuggestionStatus };
    if (mediaItemId) {
      where.mediaItemId = mediaItemId;
    }

    const [total, suggestions] = await Promise.all([
      this.prisma.locationSuggestion.count({ where }),
      this.prisma.locationSuggestion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
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

  async acceptSuggestion(id: string, dto: AcceptLocationSuggestionDto, userId: string, perms: string[]) {
    const suggestion = await this.prisma.locationSuggestion.findUnique({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException(`Location suggestion ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, suggestion.circleId, perms, CircleRole.collaborator);

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

    const patch = await applyLocation(this.geoProvider, useLat, useLng, null, coordSource);

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

  async rejectSuggestion(id: string, userId: string, perms: string[]) {
    const suggestion = await this.prisma.locationSuggestion.findUnique({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException(`Location suggestion ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, suggestion.circleId, perms, CircleRole.collaborator);

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

  async revertSuggestion(id: string, userId: string, perms: string[]) {
    const suggestion = await this.prisma.locationSuggestion.findUnique({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException(`Location suggestion ${id} not found`);
    }

    await this.membership.assertCircleAccess(userId, suggestion.circleId, perms, CircleRole.collaborator);

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
  // Bulk accept
  // ---------------------------------------------------------------------------

  /**
   * Public entrypoint — enqueue an async `location_bulk_accept` job and return
   * immediately. The old synchronous loop ran an uncapped findMany + a
   * reverse-geocode call + a $transaction per pending suggestion, which blew
   * past the nginx 60s proxy timeout (→ 504 with partial application) on
   * post-import backlogs of thousands of suggestions (issue #125). The actual
   * work now runs in bounded batches on the enrichment worker via
   * processBulkAccept below.
   */
  async bulkAcceptSuggestions(dto: BulkAcceptLocationSuggestionsDto, userId: string, perms: string[]) {
    await this.membership.assertCircleAccess(userId, dto.circleId, perms, CircleRole.collaborator);

    // Dedup-safe enqueue (mirrors the face_auto_archive_sweep pattern): a
    // pending/running bulk-accept for this circle is returned as-is rather than
    // stacking a second job. `skipDedup: true` is required because the default
    // dedup collapses ALL global (mediaItemId=null) jobs of a type into one —
    // this per-circle guard is the narrower, correct dedup.
    const existing = await this.prisma.enrichmentJob.findFirst({
      where: {
        type: 'location_bulk_accept',
        circleId: dto.circleId,
        status: { in: [JobStatus.pending, JobStatus.running] },
      },
    });

    if (existing) {
      this.logger.debug(
        `Bulk-accept job already ${existing.status} for circle ${dto.circleId}; returning job ${existing.id}`,
      );
      return { data: { jobId: existing.id, status: existing.status } };
    }

    const job = await this.enrichmentJobService.enqueue({
      type: 'location_bulk_accept',
      mediaItemId: null,
      circleId: dto.circleId,
      reason: JobReason.rerun,
      priority: 0,
      skipDedup: true,
      payload: { minConfidence: dto.minConfidence, requestedById: userId },
    });

    this.logger.log(
      `Bulk-accept job ${job.id} enqueued for circle ${dto.circleId} by user ${userId} (minConfidence=${dto.minConfidence})`,
    );

    return { data: { jobId: job.id, status: job.status } };
  }

  /**
   * The ACTUAL bulk-accept work, run asynchronously by the
   * `location_bulk_accept` enrichment handler. Processes pending suggestions in
   * bounded batches so a large backlog drains without unbounded memory. Each
   * accepted row leaves the `pending` set, so re-querying `take: BATCH` with a
   * stable `createdAt asc` order naturally advances (no offset needed).
   */
  async processBulkAccept(circleId: string, minConfidence: number, requestedById: string): Promise<number> {
    let accepted = 0;

    for (;;) {
      const batch = await this.prisma.locationSuggestion.findMany({
        where: {
          circleId,
          status: LocationSuggestionStatus.pending,
          confidence: { gte: minConfidence },
        },
        take: LocationSuggestionService.BULK_ACCEPT_BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
      });

      if (batch.length === 0) break;

      for (const s of batch) {
        // Bulk-accept never carries a per-item lat/lng override, so coords are
        // always unmodified -> coordSource='inferred'.
        const patch = await applyLocation(this.geoProvider, s.lat, s.lng, null, 'inferred');
        await this.prisma.$transaction([
          this.prisma.mediaItem.update({ where: { id: s.mediaItemId }, data: patch }),
          this.prisma.locationSuggestion.update({
            where: { id: s.id },
            data: {
              status: LocationSuggestionStatus.accepted,
              resolvedById: requestedById,
              resolvedAt: new Date(),
            },
          }),
        ]);
        accepted++;
      }

      this.logger.log(
        `Bulk-accept progress for circle ${circleId}: ${accepted} accepted so far (batch=${batch.length})`,
      );

      if (batch.length < LocationSuggestionService.BULK_ACCEPT_BATCH_SIZE) break;
    }

    await this.createAuditEvent(requestedById, 'location_suggestion:bulk_accepted', circleId, {
      count: accepted,
      minConfidence,
    });

    this.logger.log(
      `Bulk-accepted ${accepted} location suggestion(s) in circle ${circleId} by user ${requestedById} (minConfidence=${minConfidence})`,
    );

    return accepted;
  }

  // ---------------------------------------------------------------------------
  // Per-item rerun (forced — bypasses the rejected-skip rule)
  // ---------------------------------------------------------------------------

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
    await this.membership.assertCircleAccess(userId, mediaItem.circleId, perms, CircleRole.collaborator);

    if (mediaItem.type !== MediaType.photo) {
      throw new BadRequestException('Location inference only applies to photos');
    }

    const job = await this.enrichmentJobService.enqueue({
      type: 'location_inference',
      mediaItemId,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
    });

    this.logger.log(
      `Location-inference rerun job ${job.id} enqueued for MediaItem ${mediaItemId} by user ${userId}`,
    );

    return { data: { jobId: job.id, status: job.status } };
  }
}
