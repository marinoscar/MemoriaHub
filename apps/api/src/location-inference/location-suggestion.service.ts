import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CircleRole, JobReason, LocationSuggestionStatus, MediaType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { STORAGE_PROVIDER, StorageProvider } from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaUrlSigningService } from '../media/signing/media-url-signing.service';
import { GEO_LOCATION_PROVIDER, GeoLocationProvider } from '../media/geo/geo-location-provider.interface';
import { applyLocation } from '../media/geo/apply-location.util';
import { GEO_CLEAR_COLUMNS } from '../media/geo/geo-result.mapper';
import { LocationSuggestionQueryDto } from './dto/location-suggestion-query.dto';
import { AcceptLocationSuggestionDto } from './dto/accept-location-suggestion.dto';
import { BulkAcceptLocationSuggestionsDto } from './dto/bulk-accept-location-suggestions.dto';

@Injectable()
export class LocationSuggestionService {
  private readonly logger = new Logger(LocationSuggestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: CircleMembershipService,
    private readonly enrichmentJobService: EnrichmentJobService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly resolver: StorageProviderResolver,
    @Inject(GEO_LOCATION_PROVIDER) private readonly geoProvider: GeoLocationProvider,
    private readonly urlSigner: MediaUrlSigningService,
  ) {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async signThumb(metadata: Prisma.JsonValue | null): Promise<string | null> {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const meta = metadata as Record<string, unknown>;
    const key = meta['thumbnailStorageKey'];
    if (typeof key !== 'string' || !key) {
      return null;
    }
    // Same-origin byte-proxy path (Zscaler-safe): no provider lookup needed.
    if (this.urlSigner.enabled) {
      return this.urlSigner.signBlobUrl(key);
    }
    try {
      const thumbObj = await this.prisma.storageObject.findFirst({
        where: { storageKey: key },
        select: { storageProvider: true, bucket: true },
      });
      const provider = thumbObj
        ? await this.resolver.getProviderFor(thumbObj.storageProvider, thumbObj.bucket)
        : this.storageProvider;
      return await provider.getSignedDownloadUrl(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to sign thumbnail URL for key ${key}: ${msg}`);
      return null;
    }
  }

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

    const items = await Promise.all(
      suggestions.map(async (s) => ({
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
        thumbnailUrl: await this.signThumb(s.mediaItem?.metadata ?? null),
      })),
    );

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

  async bulkAcceptSuggestions(dto: BulkAcceptLocationSuggestionsDto, userId: string, perms: string[]) {
    await this.membership.assertCircleAccess(userId, dto.circleId, perms, CircleRole.collaborator);

    const suggestions = await this.prisma.locationSuggestion.findMany({
      where: {
        circleId: dto.circleId,
        status: LocationSuggestionStatus.pending,
        confidence: { gte: dto.minConfidence },
      },
    });

    let accepted = 0;
    for (const s of suggestions) {
      // Bulk-accept never carries a per-item lat/lng override, so coords are
      // always unmodified -> coordSource='inferred'.
      const patch = await applyLocation(this.geoProvider, s.lat, s.lng, null, 'inferred');
      await this.prisma.$transaction([
        this.prisma.mediaItem.update({ where: { id: s.mediaItemId }, data: patch }),
        this.prisma.locationSuggestion.update({
          where: { id: s.id },
          data: { status: LocationSuggestionStatus.accepted, resolvedById: userId, resolvedAt: new Date() },
        }),
      ]);
      accepted++;
    }

    await this.createAuditEvent(userId, 'location_suggestion:bulk_accepted', dto.circleId, {
      count: accepted,
      minConfidence: dto.minConfidence,
    });

    this.logger.log(
      `Bulk-accepted ${accepted} location suggestion(s) in circle ${dto.circleId} by user ${userId} (minConfidence=${dto.minConfidence})`,
    );

    return { data: { accepted } };
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
