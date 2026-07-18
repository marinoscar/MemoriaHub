import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CircleRole, JobReason, MediaTagSource, MediaType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../../media/media.service';
import { MediaEnrichmentService } from '../../media/enrichment/media-enrichment.service';
import { PeopleService } from '../../face/people.service';
import { BurstService } from '../../burst/burst.service';
import { DuplicateService } from '../../dedup/duplicate.service';
import { LocationSuggestionService } from '../../location-inference/location-suggestion.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { BulkDeleteDto } from '../../media/dto/bulk-delete.dto';
import { BulkArchiveDto } from '../../media/dto/bulk-archive.dto';
import { BulkTagsDto } from '../../media/dto/bulk-tags.dto';
import { BulkUpdateMediaDto } from '../../media/dto/bulk-update-media.dto';
import { AddAlbumItemsDto } from '../../media/dto/add-album-items.dto';
import { CreateAlbumDto } from '../../media/dto/create-album.dto';
import { ResolveBurstDto } from '../../burst/dto/resolve-burst.dto';
import { ResolveDuplicateDto } from '../../dedup/dto/resolve-duplicate.dto';
import { AcceptLocationSuggestionDto } from '../../location-inference/dto/accept-location-suggestion.dto';
import {
  ActionOutcome,
  WorkflowAction,
  WorkflowActionContext,
  WorkflowActionItem,
} from './action-executor.types';

/**
 * WorkflowActionExecutor — applies a single Media-Item workflow action (the
 * "Then" half, issue #140) to a single item and returns a structured outcome.
 *
 * Design:
 *   - Every action reuses an existing service method VERBATIM (each of which
 *     performs its own per-circle role check + super-admin bypass via
 *     `ctx.actorPermissions`). The ONLY hand-rolled mutation is `move_to_circle`
 *     — the single cross-circle cascade — which has no equivalent reusable
 *     method.
 *   - The executor is free of run-lifecycle concerns: no workflow_run_items
 *     writes, no batching. It loads only the tiny per-item state each action
 *     needs with targeted selects.
 *   - Thrown errors are caught and converted to `{ status: 'failed' }`; a
 *     BadRequest/NotFound that clearly means "nothing to do" is mapped to
 *     `{ status: 'skipped' }` with a reason.
 */
@Injectable()
export class WorkflowActionExecutor {
  private readonly logger = new Logger(WorkflowActionExecutor.name);

  /**
   * Per-run album-name → albumId cache for `add_to_album` with
   * `createAlbumNamed`. Keyed by runId so a "create album X and add all
   * matching items" workflow resolves/creates album X exactly ONCE per run and
   * reuses it for every subsequent item (createAlbum has no find-or-create). The
   * engine should call `clearRunCache(runId)` when a run finishes to release it.
   */
  private readonly albumNameCache = new Map<string, Map<string, string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly enrichment: MediaEnrichmentService,
    private readonly people: PeopleService,
    private readonly burst: BurstService,
    private readonly duplicate: DuplicateService,
    private readonly locationSuggestions: LocationSuggestionService,
    private readonly enrichmentJobs: EnrichmentJobService,
    private readonly membership: CircleMembershipService,
  ) {}

  /** Release a finished run's album-name cache (called by the run engine). */
  clearRunCache(runId: string): void {
    this.albumNameCache.delete(runId);
  }

  async execute(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    try {
      switch (action.type) {
        case 'move_to_trash':
          return await this.moveToTrash(item, ctx);
        case 'hard_delete':
          return await this.hardDelete(item);
        case 'archive':
          return await this.archive(item, ctx);
        case 'unarchive':
          return await this.unarchive(item, ctx);
        case 'add_to_album':
          return await this.addToAlbum(action, item, ctx);
        case 'remove_from_album':
          return await this.removeFromAlbum(action, item, ctx);
        case 'add_tags':
          return await this.addTags(action, item, ctx);
        case 'remove_tags':
          return await this.removeTags(action, item, ctx);
        case 'set_favorite':
          return await this.setFavorite(action, item, ctx);
        case 'set_captured_at':
          return await this.setCapturedAt(action, item, ctx);
        case 'assign_person':
          return await this.assignPerson(action, item, ctx);
        case 'remove_person':
          return await this.removePerson(action, item, ctx);
        case 'set_location':
          return await this.setLocation(action, item, ctx);
        case 'clear_location':
          return await this.clearLocation(item, ctx);
        case 'move_to_circle':
          return await this.moveToCircle(action, item, ctx);
        case 'rerun_enrichment':
          return await this.rerunEnrichment(action, item, ctx);
        case 'resolve_burst_group':
          return await this.resolveBurstGroup(action, item, ctx);
        case 'dismiss_burst_group':
          return await this.dismissBurstGroup(item, ctx);
        case 'resolve_duplicate_group':
          return await this.resolveDuplicateGroup(action, item, ctx);
        case 'dismiss_duplicate_group':
          return await this.dismissDuplicateGroup(item, ctx);
        case 'accept_location_suggestion':
          return await this.acceptLocationSuggestion(item, ctx);
        case 'reject_location_suggestion':
          return await this.rejectLocationSuggestion(item, ctx);
        default:
          return { status: 'failed', detail: `Unknown action type "${action.type}"` };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Action ${action.type} failed for item ${item.id} (run ${ctx.runId}): ${detail}`,
      );
      return { status: 'failed', detail };
    }
  }

  // ---------------------------------------------------------------------------
  // Item-level actions
  // ---------------------------------------------------------------------------

  private async moveToTrash(item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    const { deleted } = await this.media.bulkDelete(
      { circleId: ctx.circleId, ids: [item.id] } as BulkDeleteDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return deleted > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  /**
   * TERMINAL: permanently purge the item (DB row + storage blob). Reuses
   * MediaService.purgeMediaItems verbatim. Authorization (media:delete +
   * workflows.allowHardDelete gate) is enforced upstream at run-create/approval.
   */
  private async hardDelete(item: WorkflowActionItem): Promise<ActionOutcome> {
    const purged = await this.media.purgeMediaItems([item.id]);
    return purged > 0
      ? { status: 'applied', terminal: true }
      : { status: 'skipped', reason: 'not_found' };
  }

  private async archive(item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    const { archived } = await this.media.bulkArchive(
      { circleId: ctx.circleId, ids: [item.id] } as BulkArchiveDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return archived > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  private async unarchive(item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    const { unarchived } = await this.media.bulkUnarchive(
      { circleId: ctx.circleId, ids: [item.id] } as BulkArchiveDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return unarchived > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  private async addToAlbum(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const albumId = (action.params['albumId'] as string | undefined) ?? undefined;
    const createAlbumNamed = (action.params['createAlbumNamed'] as string | undefined) ?? undefined;

    const targetAlbumId = albumId
      ? albumId
      : await this.resolveOrCreateAlbum(ctx, createAlbumNamed as string);

    await this.media.addAlbumItems(
      targetAlbumId,
      { mediaItemIds: [item.id] } as AddAlbumItemsDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return { status: 'applied' };
  }

  private async resolveOrCreateAlbum(ctx: WorkflowActionContext, name: string): Promise<string> {
    let perRun = this.albumNameCache.get(ctx.runId);
    if (!perRun) {
      perRun = new Map<string, string>();
      this.albumNameCache.set(ctx.runId, perRun);
    }
    const cached = perRun.get(name);
    if (cached) return cached;

    const album = await this.media.createAlbum(
      { circleId: ctx.circleId, name } as CreateAlbumDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    perRun.set(name, album.id);
    return album.id;
  }

  private async removeFromAlbum(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const albumId = action.params['albumId'] as string;
    try {
      await this.media.removeAlbumItem(albumId, item.id, ctx.actorUserId, ctx.actorPermissions);
      return { status: 'applied' };
    } catch (err) {
      if (err instanceof NotFoundException) return { status: 'skipped', reason: 'not_in_album' };
      throw err;
    }
  }

  private async addTags(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const names = action.params['names'] as string[];
    const { added } = await this.media.bulkTags(
      { circleId: ctx.circleId, ids: [item.id], add: names } as BulkTagsDto,
      ctx.actorUserId,
      ctx.actorPermissions,
      { addSource: MediaTagSource.system },
    );
    return added > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  private async removeTags(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const names = action.params['names'] as string[];
    // sources defaults to ['ai','system'] in the param schema, so a cleanup
    // workflow never strips a user's manually-applied tags.
    const sources = action.params['sources'] as MediaTagSource[];
    const { removed } = await this.media.bulkTags(
      { circleId: ctx.circleId, ids: [item.id], remove: names } as BulkTagsDto,
      ctx.actorUserId,
      ctx.actorPermissions,
      { removeSources: sources },
    );
    return removed > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  private async setFavorite(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const value = action.params['value'] as boolean;
    const { updated } = await this.media.bulkUpdateMedia(
      { circleId: ctx.circleId, ids: [item.id], set: { favorite: value } } as BulkUpdateMediaDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return updated > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  private async setCapturedAt(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const mode = action.params['mode'] as 'set' | 'shift' | 'clear';

    let capturedAt: Date | null;
    if (mode === 'set') {
      capturedAt = new Date(action.params['value'] as string);
    } else if (mode === 'clear') {
      capturedAt = null;
    } else {
      // shift: read the item's current capturedAt and offset it.
      const row = await this.prisma.mediaItem.findUnique({
        where: { id: item.id },
        select: { capturedAt: true },
      });
      if (!row?.capturedAt) return { status: 'skipped', reason: 'null_captured_at' };
      const shiftMinutes = action.params['shiftMinutes'] as number;
      capturedAt = new Date(row.capturedAt.getTime() + shiftMinutes * 60_000);
    }

    const { updated } = await this.media.bulkUpdateMedia(
      { circleId: ctx.circleId, ids: [item.id], set: { capturedAt } } as BulkUpdateMediaDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return updated > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  private async assignPerson(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const personId = action.params['personId'] as string;
    await this.people.addPersonToMedia(item.id, ctx.actorUserId, ctx.actorPermissions, { personId });
    return { status: 'applied' };
  }

  private async removePerson(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const personId = action.params['personId'] as string;
    try {
      await this.people.removePersonFromMedia(item.id, personId, ctx.actorUserId, ctx.actorPermissions);
      return { status: 'applied' };
    } catch (err) {
      if (err instanceof NotFoundException) return { status: 'skipped', reason: 'no_association' };
      throw err;
    }
  }

  private async setLocation(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    // Reuses MediaService.bulkUpdateMedia, which internally calls the shared
    // applyLocation() helper (coords + coordSource='manual' + reverse-geocode).
    const lat = action.params['lat'] as number;
    const lng = action.params['lng'] as number;
    const { updated } = await this.media.bulkUpdateMedia(
      { circleId: ctx.circleId, ids: [item.id], set: { location: { lat, lng } } } as BulkUpdateMediaDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return updated > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  private async clearLocation(item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    // location: null routes bulkUpdateMedia through GEO_CLEAR_COLUMNS (also nulls
    // coordSource) — no hand-rolled update needed.
    const { updated } = await this.media.bulkUpdateMedia(
      { circleId: ctx.circleId, ids: [item.id], set: { location: null } } as BulkUpdateMediaDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return updated > 0 ? { status: 'applied' } : { status: 'skipped', reason: 'noop' };
  }

  /**
   * move_to_circle — the ONE action with cross-circle cascade semantics.
   *
   * Re-verifies collaborator access on BOTH the source (ctx.circleId) and the
   * target circle at execute time (assertCircleAccess honors the super-admin
   * bypass). Skips on a content-hash collision with an active item in the
   * target circle. Otherwise, in one transaction, reassigns circle_id, drops
   * the item's circle-scoped associations (album_items, faces, media_tags) and
   * its source-circle burst/duplicate group pointers, then re-fires enrichment
   * in the target circle via the canonical MediaEnrichmentService entry point.
   */
  private async moveToCircle(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const targetCircleId = action.params['targetCircleId'] as string;
    if (targetCircleId === ctx.circleId) return { status: 'skipped', reason: 'same_circle' };

    // Both-circle collaborator + super-admin bypass re-check at execute time.
    await this.membership.assertCircleAccess(ctx.actorUserId, ctx.circleId, ctx.actorPermissions, CircleRole.collaborator);
    await this.membership.assertCircleAccess(ctx.actorUserId, targetCircleId, ctx.actorPermissions, CircleRole.collaborator);

    const row = await this.prisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { id: true, type: true, contentHash: true, deletedAt: true },
    });
    if (!row || row.deletedAt) return { status: 'skipped', reason: 'not_found' };

    // Dedup guard: an active (non-deleted) item with the same content hash in
    // the target circle means moving would collide with the target's unique
    // (circle_id, content_hash) — skip rather than fail the move.
    if (row.contentHash) {
      const collision = await this.prisma.mediaItem.findFirst({
        where: {
          circleId: targetCircleId,
          contentHash: row.contentHash,
          deletedAt: null,
          NOT: { id: item.id },
        },
        select: { id: true },
      });
      if (collision) return { status: 'skipped', reason: 'dedup_conflict' };
    }

    await this.prisma.$transaction(async (tx) => {
      // Drop circle-scoped associations; also null the source-circle burst /
      // duplicate group pointers so the moved item never references a group in
      // its old circle.
      await tx.albumItem.deleteMany({ where: { mediaItemId: item.id } });
      await tx.face.deleteMany({ where: { mediaItemId: item.id } });
      await tx.mediaTag.deleteMany({ where: { mediaItemId: item.id } });
      await tx.mediaItem.update({
        where: { id: item.id },
        data: { circleId: targetCircleId, burstGroupId: null, duplicateGroupId: null },
      });
    });

    // Re-enqueue enrichment in the target circle via the canonical, feature-gated
    // MediaEnrichmentService entry point (self-selects per-job priorities).
    await this.enrichment.enqueueUploadEnrichment({
      id: item.id,
      type: row.type,
      circleId: targetCircleId,
      deletedAt: null,
    });

    return { status: 'applied' };
  }

  private async rerunEnrichment(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const kinds = action.params['kinds'] as Array<'tagging' | 'faces' | 'metadata' | 'thumbnail' | 'duplicates'>;

    // faces routes on media type (photo → face_detection, video → video_face_detection).
    const needsType = kinds.includes('faces');
    let type: MediaType | undefined;
    if (needsType) {
      const row = await this.prisma.mediaItem.findUnique({
        where: { id: item.id },
        select: { type: true },
      });
      if (!row) return { status: 'skipped', reason: 'not_found' };
      type = row.type;
    }

    for (const kind of kinds) {
      const jobType = this.enrichmentJobTypeForKind(kind, type);
      // Enqueue at priority 100 (bulk/background) via the shared enqueue helper
      // — NOT the priority-0 rerun helpers, which are for interactive reruns.
      await this.enrichmentJobs.enqueue({
        type: jobType,
        mediaItemId: item.id,
        circleId: ctx.circleId,
        reason: JobReason.rerun,
        priority: 100,
      });
    }
    return { status: 'applied' };
  }

  private enrichmentJobTypeForKind(
    kind: 'tagging' | 'faces' | 'metadata' | 'thumbnail' | 'duplicates',
    type: MediaType | undefined,
  ): string {
    switch (kind) {
      case 'tagging':
        return 'auto_tagging';
      case 'faces':
        return type === MediaType.video ? 'video_face_detection' : 'face_detection';
      case 'metadata':
        return 'metadata_extraction';
      case 'thumbnail':
        return 'thumbnail_regen';
      case 'duplicates':
        return 'duplicate_detection';
    }
  }

  // ---------------------------------------------------------------------------
  // Review-queue actions (act on the GROUP / suggestion, not the item alone)
  // ---------------------------------------------------------------------------

  private async resolveBurstGroup(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const dtoAction = action.params['action'] as 'archive' | 'trash';
    const row = await this.prisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { burstGroupId: true, burstGroup: { select: { status: true, suggestedBestItemId: true } } },
    });
    if (!row?.burstGroupId || row.burstGroup?.status !== 'pending') {
      return { status: 'skipped', reason: 'no_pending_target' };
    }
    if (ctx.handledGroups.has(row.burstGroupId)) return { status: 'skipped', reason: 'same_group' };
    // Mirror the bulk-resolve semantics: keep the group's suggested-best member,
    // archive/trash the rest. A group with no suggested-best is skipped (the
    // reused resolve requires a non-empty keepIds).
    const bestId = row.burstGroup?.suggestedBestItemId;
    if (!bestId) return { status: 'skipped', reason: 'no_suggested_best' };

    await this.burst.resolveBurstGroup(
      row.burstGroupId,
      { keepIds: [bestId], action: dtoAction } as ResolveBurstDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    ctx.handledGroups.add(row.burstGroupId);
    return { status: 'applied' };
  }

  private async dismissBurstGroup(item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    const row = await this.prisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { burstGroupId: true, burstGroup: { select: { status: true } } },
    });
    if (!row?.burstGroupId || row.burstGroup?.status !== 'pending') {
      return { status: 'skipped', reason: 'no_pending_target' };
    }
    if (ctx.handledGroups.has(row.burstGroupId)) return { status: 'skipped', reason: 'same_group' };

    await this.burst.dismissBurstGroup(row.burstGroupId, ctx.actorUserId, ctx.actorPermissions);
    ctx.handledGroups.add(row.burstGroupId);
    return { status: 'applied' };
  }

  private async resolveDuplicateGroup(
    action: WorkflowAction,
    item: WorkflowActionItem,
    ctx: WorkflowActionContext,
  ): Promise<ActionOutcome> {
    const dtoAction = action.params['action'] as 'archive' | 'trash';
    const row = await this.prisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { duplicateGroupId: true, duplicateGroup: { select: { status: true, suggestedBestItemId: true } } },
    });
    if (!row?.duplicateGroupId || row.duplicateGroup?.status !== 'pending') {
      return { status: 'skipped', reason: 'no_pending_target' };
    }
    if (ctx.handledGroups.has(row.duplicateGroupId)) return { status: 'skipped', reason: 'same_group' };
    const bestId = row.duplicateGroup?.suggestedBestItemId;
    if (!bestId) return { status: 'skipped', reason: 'no_suggested_best' };

    await this.duplicate.resolveDuplicateGroup(
      row.duplicateGroupId,
      { keepIds: [bestId], action: dtoAction } as ResolveDuplicateDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    ctx.handledGroups.add(row.duplicateGroupId);
    return { status: 'applied' };
  }

  private async dismissDuplicateGroup(item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    const row = await this.prisma.mediaItem.findUnique({
      where: { id: item.id },
      select: { duplicateGroupId: true, duplicateGroup: { select: { status: true } } },
    });
    if (!row?.duplicateGroupId || row.duplicateGroup?.status !== 'pending') {
      return { status: 'skipped', reason: 'no_pending_target' };
    }
    if (ctx.handledGroups.has(row.duplicateGroupId)) return { status: 'skipped', reason: 'same_group' };

    await this.duplicate.dismissDuplicateGroup(row.duplicateGroupId, ctx.actorUserId, ctx.actorPermissions);
    ctx.handledGroups.add(row.duplicateGroupId);
    return { status: 'applied' };
  }

  private async acceptLocationSuggestion(item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    // Location suggestions are unique per item — no group dedup.
    const suggestion = await this.prisma.locationSuggestion.findUnique({
      where: { mediaItemId: item.id },
      select: { id: true, status: true },
    });
    if (!suggestion || suggestion.status !== 'pending') {
      return { status: 'skipped', reason: 'no_pending_target' };
    }
    await this.locationSuggestions.acceptSuggestion(
      suggestion.id,
      {} as AcceptLocationSuggestionDto,
      ctx.actorUserId,
      ctx.actorPermissions,
    );
    return { status: 'applied' };
  }

  private async rejectLocationSuggestion(item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    const suggestion = await this.prisma.locationSuggestion.findUnique({
      where: { mediaItemId: item.id },
      select: { id: true, status: true },
    });
    if (!suggestion || suggestion.status !== 'pending') {
      return { status: 'skipped', reason: 'no_pending_target' };
    }
    await this.locationSuggestions.rejectSuggestion(suggestion.id, ctx.actorUserId, ctx.actorPermissions);
    return { status: 'applied' };
  }
}
