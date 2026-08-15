import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CircleRole,
  JobStatus,
  MediaType,
  MediaEnhancementBatch,
  MediaEnhancementStatus,
  MediaEnhancementDecision,
  MediaTagSource,
  JobReason,
  MediaFaceStatusType,
  Prisma,
} from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { MediaMetadataSyncService } from '../media/sync/media-metadata-sync.service';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { isPictureEnhancementEnabled } from '../common/types/settings.types';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { buildMediaWhere, wherePeople } from '../search/media-where.builder';
import { EnhanceParams } from './dto/enhance-params.dto';
import { BulkEnhance } from './dto/bulk-enhance.dto';
import { BulkEnhanceByFilter } from './dto/bulk-enhance-by-filter.dto';
import { ListEnhancementBatchesQuery } from './dto/list-enhancement-batches-query.dto';
import {
  ListEnhancementsQuery,
  resolveStatusFilter,
} from './dto/list-enhancements-query.dto';
import {
  buildEnhancePrompt,
  closestSupportedSize,
  sizeToDims,
} from './enhance-prompt.builder';
import { randomUUID } from 'crypto';
import { extname } from 'path';

const SYSTEM_TAG = 'AI Enhanced';

/** Derived batch statuses past which no further transition is possible. */
const TERMINAL_BATCH_STATUSES: string[] = [
  'completed',
  'completed_with_errors',
  'cancelled',
];

/** Per-batch status tally derived from its media_enhancements rows. */
interface BatchTally {
  counts: Record<string, number>;
  maxUpdatedAt: Date | null;
}

/** Tally for a batch with no rows at all (nothing was eligible). */
const EMPTY_TALLY: BatchTally = { counts: {}, maxUpdatedAt: null };

interface CompareSection {
  url: string | null;
  width: number | null;
  height: number | null;
  size: string | null;
}

@Injectable()
export class MediaEnhancementService {
  private readonly logger = new Logger(MediaEnhancementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembership: CircleMembershipService,
    private readonly resolver: StorageProviderResolver,
    private readonly recoveryService: StorageProcessingRecoveryService,
    private readonly metadataSync: MediaMetadataSyncService,
    private readonly mediaEnrichment: MediaEnrichmentService,
    private readonly thumbnails: MediaThumbnailService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /api/admin/ai/enhance/status
  // ---------------------------------------------------------------------------

  async getAdminStatus() {
    const settings = await this.systemSettings.getSettings();
    const featureEnabled = isPictureEnhancementEnabled(settings);
    const enhanceCfg = settings.ai?.features?.enhance ?? null;
    const provider = enhanceCfg?.provider ?? null;
    const model = enhanceCfg?.model ?? null;

    let credentialConfigured = false;
    if (provider) {
      const cred = await this.prisma.aiProviderCredential.findUnique({
        where: { provider },
      });
      credentialConfigured = !!cred && cred.enabled;
    }

    return {
      featureEnabled,
      provider,
      model,
      credentialConfigured,
      ready: featureEnabled && credentialConfigured && !!model,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/media/:id/enhance
  // ---------------------------------------------------------------------------

  async startEnhance(mediaItemId: string, params: EnhanceParams, user: RequestUser) {
    const settings = await this.systemSettings.getSettings();

    // Feature gate: system setting + env kill-switch (shared with GET /api/features).
    if (!isPictureEnhancementEnabled(settings)) {
      throw new BadRequestException('Picture enhancement is disabled');
    }

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        type: true,
        deletedAt: true,
        width: true,
        height: true,
        storageObject: { select: { id: true, mimeType: true } },
      },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.circleMembership.assertCircleAccess(
      user.id,
      mediaItem.circleId,
      user.permissions,
      'collaborator' as CircleRole,
    );

    // Photo-only guard (mirrors media-orientation-edit.service).
    if (
      mediaItem.type !== MediaType.photo ||
      !mediaItem.storageObject.mimeType.startsWith('image/')
    ) {
      throw new BadRequestException('Picture enhancement is only supported for photos');
    }

    // Enhance model must be configured.
    const enhanceCfg = settings.ai?.features?.enhance;
    if (!enhanceCfg?.provider || !enhanceCfg?.model) {
      throw new BadRequestException(
        'No enhancement model configured (ai.features.enhance is unset)',
      );
    }
    const provider = enhanceCfg.provider;
    const model = params.model ?? enhanceCfg.model;

    // Megapixel guard.
    const maxMp = settings.pictureEnhancement?.maxInputMegapixels ?? 50;
    if (mediaItem.width && mediaItem.height) {
      const mp = (mediaItem.width * mediaItem.height) / 1_000_000;
      if (mp > maxMp) {
        throw new BadRequestException(
          `Image is ${mp.toFixed(1)} MP, which exceeds the ${maxMp} MP limit`,
        );
      }
    }

    // Supersede any existing live enhancement for this item (one live at a time).
    await this.supersedeLive(mediaItemId);

    // Compile the prompt deterministically at creation time (params + strength).
    const effectiveStrength =
      params.strength ?? settings.pictureEnhancement?.defaultStrength ?? 'balanced';
    const prompt = buildEnhancePrompt(params, effectiveStrength);

    const row = await this.prisma.mediaEnhancement.create({
      data: {
        mediaItemId: mediaItem.id,
        circleId: mediaItem.circleId,
        status: MediaEnhancementStatus.pending,
        params: (params ?? {}) as Prisma.InputJsonValue,
        provider,
        model,
        prompt,
        originalWidth: mediaItem.width,
        originalHeight: mediaItem.height,
        createdById: user.id,
      },
    });

    const job = await this.enrichmentJobService.enqueue({
      type: 'picture_enhancement',
      mediaItemId: mediaItem.id,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
      // skipDedup is REQUIRED here, not an optimization. EnrichmentJobService
      // dedups on (type, mediaItemId, status in pending|running) and returns the
      // EXISTING job — whose payload points at the enhancement id superseded by
      // the supersedeLive() call two statements up. Without this flag,
      // re-enhancing an item whose previous job is still `pending` silently
      // hands back that stale job, the handler resolves the now-`discarded` row
      // and early-returns, and the row just created sits at `pending` forever.
      // The media_enhancements row (one live per item, enforced by
      // supersedeLive) is the real idempotency unit here — not the job row.
      skipDedup: true,
      providerKey: provider,
      modelVersion: model,
      payload: { enhancementId: row.id },
    });

    this.logger.log(
      `Enqueued picture_enhancement job ${job.id} for enhancement ${row.id} (MediaItem ${mediaItem.id})`,
    );

    return { data: { enhancementId: row.id, jobId: job.id, status: 'pending' } };
  }

  /**
   * Discard the staging bytes of, and mark discarded, any live (pending /
   * processing / ready) enhancement for the item — one live at a time.
   */
  private async supersedeLive(mediaItemId: string): Promise<void> {
    const live = await this.prisma.mediaEnhancement.findMany({
      where: {
        mediaItemId,
        status: {
          in: [
            MediaEnhancementStatus.pending,
            MediaEnhancementStatus.processing,
            MediaEnhancementStatus.ready,
          ],
        },
      },
    });

    for (const row of live) {
      await this.deleteStaging(row);
      await this.prisma.mediaEnhancement.update({
        where: { id: row.id },
        data: {
          status: MediaEnhancementStatus.discarded,
          stagingStorageKey: null,
          stagingThumbnailKey: null,
        },
      });
      this.logger.log(`Superseded live enhancement ${row.id} for MediaItem ${mediaItemId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/media/bulk/enhance — batch enhance a selection (issue #421)
  // ---------------------------------------------------------------------------

  /**
   * Queue an AI enhancement for every eligible item in a selection.
   *
   * FOUR deliberate divergences from the single-item startEnhance path. Each is
   * commented at its site; collected here because "simplifying" any of them back
   * toward startEnhance reintroduces a real defect:
   *
   *   1. A live enhancement is SKIPPED AND COUNTED, never superseded.
   *   2. A non-photo / oversized item is SKIPPED AND COUNTED, never a 400.
   *   3. Jobs are enqueued at priority 50, not 0.
   *   4. Jobs are enqueued with skipDedup: true.
   *
   * Authorization and the batch-size cap happen here; the actual batch creation
   * lives in createBatchFrom() so a future by-filter entry point (#424) can
   * resolve its own id list server-side and reuse the rest verbatim.
   */
  async startBatch(dto: BulkEnhance, user: RequestUser) {
    const settings = await this.systemSettings.getSettings();

    // Feature gate: the SHARED helper (system setting + env kill-switch), never
    // a second hand-rolled gate that could drift from startEnhance's.
    if (!isPictureEnhancementEnabled(settings)) {
      throw new BadRequestException('Picture enhancement is disabled');
    }

    const enhanceCfg = settings.ai?.features?.enhance;
    if (!enhanceCfg?.provider || !enhanceCfg?.model) {
      throw new BadRequestException(
        'No enhancement model configured (ai.features.enhance is unset)',
      );
    }

    const uniqueIds = [...new Set(dto.ids)];

    // The AUTHORITATIVE cap (the DTO's array max is only a schema backstop).
    // Deduplicated ids are counted, so pasting the same id twice never costs a
    // caller part of their budget.
    const maxBatchSize = settings.pictureEnhancement?.maxBatchSize ?? 25;
    if (uniqueIds.length > maxBatchSize) {
      throw new BadRequestException(
        `Cannot enhance ${uniqueIds.length} items in one batch; the limit is ${maxBatchSize}`,
      );
    }

    // ONE authorization pass for the whole batch (never per item).
    await this.assertAllInCircle(uniqueIds, dto.circleId, user, 'collaborator');

    return this.createBatchFrom(
      uniqueIds,
      dto.circleId,
      dto.params ?? {},
      'selection',
      user,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /api/media/bulk/enhance/by-filter — batch enhance a filter (issue #424)
  // ---------------------------------------------------------------------------

  /**
   * Queue an AI enhancement for every photo matching a gallery filter.
   *
   * This is the ONLY path where a single click enqueues a set the user never
   * enumerated, so it is also the only one that can spend real money on items
   * nobody named. Three guards exist purely for that reason, all below:
   *
   *   1. `deletedAt` and `archivedAt` are pinned EXPLICITLY, because
   *      buildMediaWhere pins neither for us (see resolveFilterWhere).
   *   2. Photo-only is expressed in SQL, not as a post-filter, so the count the
   *      user is refused with is the count that would actually have run.
   *   3. An over-cap match is REFUSED with both numbers. It is never truncated.
   *
   * Gate ORDER matches startBatch (feature → model → …) so the disabled and
   * unconfigured paths are byte-identical between the two endpoints. The one
   * deliberate difference: authorization runs BEFORE the cap check here, not
   * after. startBatch's cap is a pure count of client-supplied ids, but this
   * one's requires counting rows in the circle — reporting `matchedCount` to a
   * caller who turned out not to be a member would leak the circle's contents.
   */
  async startBatchByFilter(dto: BulkEnhanceByFilter, user: RequestUser) {
    const settings = await this.systemSettings.getSettings();

    // Feature gate: the SHARED helper (system setting + env kill-switch),
    // identical to startBatch's — never a second hand-rolled gate.
    if (!isPictureEnhancementEnabled(settings)) {
      throw new BadRequestException('Picture enhancement is disabled');
    }

    const enhanceCfg = settings.ai?.features?.enhance;
    if (!enhanceCfg?.provider || !enhanceCfg?.model) {
      throw new BadRequestException(
        'No enhancement model configured (ai.features.enhance is unset)',
      );
    }

    // ONE authorization pass for the whole batch — and before any count, per
    // the ordering note above.
    await this.circleMembership.assertCircleAccess(
      user.id,
      dto.circleId,
      user.permissions,
      CircleRole.collaborator,
    );

    const where = this.resolveFilterWhere(dto);

    const maxBatchSize = settings.pictureEnhancement?.maxBatchSize ?? 25;
    const matchedCount = await this.prisma.mediaItem.count({ where });

    if (matchedCount === 0) {
      throw new BadRequestException('No photos match this filter');
    }

    if (matchedCount > maxBatchSize) {
      // NEVER truncate to the first `maxBatchSize` matches. A user who filters
      // to 400 photos and silently gets 25 enhanced — chosen by an ordering
      // they cannot see — has been charged for a result they did not ask for
      // and cannot reason about. Refusing with BOTH numbers lets them narrow
      // the filter or ask an admin to raise the cap.
      //
      // `matchedCount`/`maxBatchSize` MUST live under `details`: the app-wide
      // HttpExceptionFilter rebuilds every error body from a fixed key
      // allowlist (message, code, details, error, error_description,
      // startedAt), so a top-level custom field is silently dropped and never
      // reaches the client — while err.getResponse() in a unit test still
      // shows it present. Documented repo gotcha; it has bitten before.
      throw new BadRequestException({
        message: `${matchedCount} photos match this filter; the limit is ${maxBatchSize} per batch.`,
        details: { matchedCount, maxBatchSize },
      });
    }

    // A plain findMany with no pagination is safe ONLY because the cap check
    // above already bounded the result to maxBatchSize rows. This deliberately
    // does NOT copy addAlbumItemsByFilter's unbounded id fetch, which is fine
    // for cheap album joins and not for a set that costs money to process.
    const matches = await this.prisma.mediaItem.findMany({
      where,
      select: { id: true },
    });

    return this.createBatchFrom(
      matches.map((m) => m.id),
      dto.circleId,
      dto.params ?? {},
      'filter',
      user,
      // Provenance: the resolved filter is snapshotted onto the BATCH row so a
      // reviewer can later see what the user actually asked for, not just how
      // many items it happened to match.
      this.snapshotFilter(dto),
    );
  }

  /**
   * Compile a by-filter request into the Prisma `where` the batch is resolved
   * from. Three predicates are pinned here that buildMediaWhere will NOT add:
   *
   *  - `deletedAt: null` — buildMediaWhere never filters trash for us. Its
   *    `excludeArchived` flag touches ONLY `archivedAt`. Without this pin a
   *    by-filter enhance would spend real money re-rendering photos sitting in
   *    the Trash.
   *  - `archivedAt: null` — pinned directly rather than via `excludeArchived`,
   *    so the guarantee does not depend on a flag another caller could stop
   *    passing.
   *  - `type: photo` — enhancement is photo-only, and this belongs in the SQL
   *    rather than a post-filter: counting videos and then skipping them would
   *    make the cap check (and the number the user is refused with) lie.
   *
   * A caller that explicitly filters `type=video` therefore matches nothing and
   * gets the "no photos match" 400 — which is the honest answer.
   */
  private resolveFilterWhere(dto: BulkEnhanceByFilter): Prisma.MediaItemWhereInput {
    const {
      circleId,
      type,
      capturedAtFrom,
      capturedAtTo,
      albumId,
      favorite,
      tag,
      country,
      region,
      locality,
      place,
      location,
      contentHash,
      cameraMake,
      cameraModel,
      sourceDeviceId,
      sourceDeviceName,
      missingGeo,
      missingCapturedAt,
      missingCamera,
      noFaces,
      personId,
      personIds,
      peopleMatch,
    } = dto;

    // People filtering is NOT part of buildMediaWhere — it is the separate
    // wherePeople() export (same split as MediaService.addAlbumItemsByFilter).
    const effectivePersonIds =
      personIds && personIds.length > 0 ? personIds : personId ? [personId] : [];

    const base = buildMediaWhere(circleId, {
      type,
      capturedAtFrom,
      capturedAtTo,
      albumId,
      favorite,
      tag,
      country,
      region,
      locality,
      place,
      location,
      contentHash,
      cameraMake,
      cameraModel,
      sourceDeviceId,
      sourceDeviceName,
      missingGeo,
      missingCapturedAt,
      missingCamera,
      noFaces,
    });
    const people =
      effectivePersonIds.length > 0
        ? wherePeople(effectivePersonIds, peopleMatch ?? 'any')
        : {};

    // ---- AND-key collision: MERGE, never spread. Do not "simplify" this back. --
    // buildMediaWhere collects EVERY filter fragment into a single top-level
    // `AND` array (deliberately, so two fragments that each emit an `OR` cannot
    // clobber each other). wherePeople(ids, 'all') ALSO returns a top-level
    // `AND` array. Object-spreading the two therefore lets the people `AND`
    // silently OVERWRITE the filter `AND`, dropping every other condition the
    // user asked for and WIDENING the match set — which on this endpoint means
    // paying gpt-image-1 to enhance photos the filter never described.
    // ('any' mode is unaffected: it returns a `faces` key, not `AND`.)
    //
    // The same collision exists at the two pre-existing buildMediaWhere +
    // wherePeople call sites (MediaService.listMedia and
    // addAlbumItemsByFilter), which still spread. Fixing it in the shared
    // builder would change gallery/album behaviour app-wide and is tracked
    // separately; it is fixed HERE only. The resulting asymmetry is safe in
    // this direction: this endpoint resolves the NARROWER, correct set and
    // refuses rather than truncates, so it can never overcharge.
    const { AND: baseAnd, ...baseRest } = base;
    const { AND: peopleAnd, ...peopleRest } = people;
    const asArray = (
      and: Prisma.MediaItemWhereInput['AND'],
    ): Prisma.MediaItemWhereInput[] =>
      and === undefined ? [] : Array.isArray(and) ? and : [and];
    const mergedAnd = [...asArray(baseAnd), ...asArray(peopleAnd)];

    return {
      ...baseRest,
      ...peopleRest,
      ...(mergedAnd.length > 0 ? { AND: mergedAnd } : {}),
      // The three pins — see the doc comment above. Kept last so they can never
      // be shadowed by a spread.
      deletedAt: null,
      archivedAt: null,
      type: MediaType.photo,
    };
  }

  /**
   * Project a by-filter request down to the filter fields that were actually
   * supplied, for storage on the batch row. `params` is excluded (it is stored
   * on its own), and `undefined` values are dropped so the snapshot reads as
   * "what the user set", not "every field the DTO knows about".
   *
   * The two date fields arrive as JS `Date`s (the DTO pipes them through
   * `z.coerce.date()`), which is not a JSON value — so they are stringified
   * here explicitly rather than leaning on Prisma's Date-in-JSONB coercion.
   */
  private snapshotFilter(dto: BulkEnhanceByFilter): Record<string, unknown> {
    const { params: _params, ...filter } = dto;
    return Object.fromEntries(
      Object.entries(filter)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
    );
  }

  /**
   * Post-authorization half of a batch enhance: partition the ids, create the
   * batch row, then create + enqueue one enhancement per eligible item.
   *
   * Deliberately takes an already-authorized id list so #424's by-filter entry
   * point can resolve ids server-side and call straight into here — the caller
   * owns "which items", this owns "what happens to them".
   */
  private async createBatchFrom(
    ids: string[],
    circleId: string,
    params: EnhanceParams,
    source: 'selection' | 'filter',
    user: RequestUser,
    /**
     * Optional provenance for a `source: 'filter'` batch — the resolved filter,
     * recorded on the BATCH row's params under `_filter` (the repo-wide
     * underscore convention for internal/derived keys). Deliberately NOT copied
     * onto the per-item enhancement rows: those carry the enhance params the
     * prompt was compiled from, and a filter is not one of them.
     */
    filterSnapshot?: Record<string, unknown>,
  ) {
    // Cached (5 s TTL) — no extra DB read path.
    const settings = await this.systemSettings.getSettings();

    // Re-checked rather than assumed from the caller: this helper is the reuse
    // seam for #424's by-filter entry point, and a future caller that forgot the
    // gate would otherwise write rows with an undefined provider/model.
    const enhanceCfg = settings.ai?.features?.enhance;
    if (!enhanceCfg?.provider || !enhanceCfg?.model) {
      throw new BadRequestException(
        'No enhancement model configured (ai.features.enhance is unset)',
      );
    }
    const provider = enhanceCfg.provider;
    const model = params.model ?? enhanceCfg.model;

    const items = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        circleId: true,
        type: true,
        width: true,
        height: true,
        storageObject: { select: { id: true, mimeType: true } },
      },
    });

    // ONE query for every id's live-enhancement state, not one per item.
    const liveRows = await this.prisma.mediaEnhancement.findMany({
      where: {
        mediaItemId: { in: ids },
        status: {
          in: [
            MediaEnhancementStatus.pending,
            MediaEnhancementStatus.processing,
            MediaEnhancementStatus.ready,
          ],
        },
      },
      select: { mediaItemId: true },
    });
    const liveItemIds = new Set(liveRows.map((r) => r.mediaItemId));

    const maxMp = settings.pictureEnhancement?.maxInputMegapixels ?? 50;

    // Partition. Precedence is notPhoto → tooLarge → alreadyLive, so every id
    // lands in EXACTLY ONE bucket and the four counts always sum to `requested`.
    const skipped = { notPhoto: 0, tooLarge: 0, alreadyLive: 0 };
    const eligible: typeof items = [];

    for (const item of items) {
      // DIVERGENCE 2a: startEnhance throws 400 for a non-photo. A batch must
      // not fail wholesale because one video slipped into a mixed selection —
      // the ineligible item is reported in `skipped` and the rest proceed.
      if (
        item.type !== MediaType.photo ||
        !item.storageObject ||
        !item.storageObject.mimeType.startsWith('image/')
      ) {
        skipped.notPhoto++;
        continue;
      }

      // DIVERGENCE 2b: same reasoning for the megapixel guard.
      if (item.width && item.height && (item.width * item.height) / 1_000_000 > maxMp) {
        skipped.tooLarge++;
        continue;
      }

      // DIVERGENCE 1 — THE most important rule in this method. startEnhance
      // calls supersedeLive(), which DISCARDS a live enhancement and deletes its
      // staged bytes. A batch must NEVER do that: a `ready` row is a completed,
      // already-billed gpt-image-1 result awaiting a human keep/replace/discard
      // decision, and silently destroying it because the item happened to be in
      // a later selection loses both the work and the money. Skip and report.
      //
      // This rule is also what makes DIVERGENCE 4 (skipDedup) safe: at most one
      // live enhancement — and therefore at most one in-flight job — can exist
      // per item, enforced here rather than by the queue's dedup.
      if (liveItemIds.has(item.id)) {
        skipped.alreadyLive++;
        continue;
      }

      eligible.push(item);
    }

    // An id that vanished between the authorization read and this one (a
    // concurrent hard delete) is counted as notPhoto — it is ineligible, and
    // failing the whole batch over a race would be worse than reporting it.
    skipped.notPhoto += ids.length - items.length;

    // The batch row is created even when nothing is eligible: the caller asked
    // for something and deserves a record (and a pollable id) explaining why
    // zero items were queued, rather than a bare 202 with no trace.
    const batch = await this.prisma.mediaEnhancementBatch.create({
      data: {
        circleId,
        requestedCount: ids.length,
        queuedCount: 0,
        skipped: skipped as unknown as Prisma.InputJsonValue,
        params: (filterSnapshot
          ? { ...(params ?? {}), _filter: filterSnapshot }
          : (params ?? {})) as Prisma.InputJsonValue,
        source,
        createdById: user.id,
      },
    });

    const effectiveStrength =
      params.strength ?? settings.pictureEnhancement?.defaultStrength ?? 'balanced';
    const prompt = buildEnhancePrompt(params, effectiveStrength);

    let queued = 0;
    for (const item of eligible) {
      const row = await this.prisma.mediaEnhancement.create({
        data: {
          mediaItemId: item.id,
          circleId: item.circleId,
          batchId: batch.id,
          status: MediaEnhancementStatus.pending,
          params: (params ?? {}) as Prisma.InputJsonValue,
          provider,
          model,
          prompt,
          originalWidth: item.width,
          originalHeight: item.height,
          createdById: user.id,
        },
      });

      await this.enrichmentJobService.enqueue({
        type: 'picture_enhancement',
        mediaItemId: item.id,
        circleId: item.circleId,
        reason: JobReason.rerun,
        // DIVERGENCE 3: a single-item enhance is an interactive request the user
        // is watching, so it jumps the queue at priority 0. A batch is bulk work
        // — it sits BELOW upload enrichment (5/10) and workflow evaluate (20) so
        // a large selection never starves a live import, and ABOVE the purges
        // (100) so it still drains promptly.
        priority: 50,
        // DIVERGENCE 4: queue dedup on (type, mediaItemId, pending|running)
        // would collapse a legitimate re-queue into a stale job pointing at an
        // older enhancement row. The enhancement row is the idempotency unit,
        // and the alreadyLive skip above guarantees at most one live row (hence
        // at most one in-flight job) per item.
        skipDedup: true,
        providerKey: provider,
        modelVersion: model,
        payload: { enhancementId: row.id },
      });
      queued++;
    }

    await this.prisma.mediaEnhancementBatch.update({
      where: { id: batch.id },
      data: { queuedCount: queued },
    });

    this.logger.log(
      `Enhancement batch ${batch.id} (${source}) in circle ${circleId}: requested=${ids.length} queued=${queued} ` +
        `skipped=${JSON.stringify(skipped)}`,
    );

    return {
      data: {
        batchId: batch.id,
        requested: ids.length,
        queued,
        skipped,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // GET /api/enhancement-batches  ·  GET|POST /api/enhancement-batches/:id[/cancel]
  // ---------------------------------------------------------------------------

  /** Paginated batch list for a circle, newest first (circle viewer). */
  async listBatches(query: ListEnhancementBatchesQuery, user: RequestUser) {
    const { circleId, page, pageSize } = query;

    await this.circleMembership.assertCircleAccess(
      user.id,
      circleId,
      user.permissions,
      CircleRole.viewer,
    );

    // Served by the existing @@index([circleId, createdAt]); `id` tiebreak keeps
    // paging deterministic when two batches share a createdAt.
    const where: Prisma.MediaEnhancementBatchWhereInput = { circleId };
    const [batches, totalItems] = await this.prisma.$transaction([
      this.prisma.mediaEnhancementBatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.mediaEnhancementBatch.count({ where }),
    ]);

    // ONE groupBy for the whole page — never one per batch.
    const tallies = await this.tallyBatches(batches.map((b) => b.id));

    return {
      items: batches.map((b) =>
        this.serializeBatch(b, tallies.get(b.id) ?? EMPTY_TALLY),
      ),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  /** Single batch detail — the BaseRun-shaped progress payload (circle viewer). */
  async getBatch(batchId: string, user: RequestUser) {
    const batch = await this.loadBatch(batchId, user, CircleRole.viewer);
    const tallies = await this.tallyBatches([batch.id]);
    return this.serializeBatch(batch, tallies.get(batch.id) ?? EMPTY_TALLY);
  }

  /**
   * Cancel a non-terminal batch (circle collaborator).
   *
   * Only rows still at `pending` are affected: their queued job row is deleted
   * and the row is marked `cancelled`. A row already at `processing` is left
   * running ON PURPOSE — its gpt-image-1 call is already billed, so aborting it
   * spends the money and throws away the result. A `running` job row is likewise
   * left alone; deleting it out from under the worker buys nothing.
   *
   * The handler's own batch-cancellation check (see PictureEnhancementHandler)
   * covers the row whose job was already claimed when this landed.
   */
  async cancelBatch(batchId: string, user: RequestUser) {
    const batch = await this.loadBatch(batchId, user, CircleRole.collaborator);

    const tallies = await this.tallyBatches([batch.id]);
    const view = this.serializeBatch(batch, tallies.get(batch.id) ?? EMPTY_TALLY);
    if (batch.cancelledAt || TERMINAL_BATCH_STATUSES.includes(view.status)) {
      throw new BadRequestException('Batch already finished');
    }

    await this.prisma.mediaEnhancementBatch.update({
      where: { id: batch.id },
      data: { cancelledAt: new Date() },
    });

    const pendingRows = await this.prisma.mediaEnhancement.findMany({
      where: { batchId: batch.id, status: MediaEnhancementStatus.pending },
      select: { id: true },
    });

    let cancelled = 0;
    if (pendingRows.length > 0) {
      // Delete only the still-PENDING job rows, matched precisely on the
      // enhancement id in their payload (never by mediaItemId, which could
      // catch an unrelated job for the same item).
      await this.prisma.enrichmentJob.deleteMany({
        where: {
          type: 'picture_enhancement',
          status: JobStatus.pending,
          OR: pendingRows.map((r) => ({
            payload: { path: ['enhancementId'], equals: r.id },
          })),
        },
      });

      // Re-filtered on `pending` so a row that started processing between the
      // read above and this write is not clobbered mid-render.
      const res = await this.prisma.mediaEnhancement.updateMany({
        where: {
          batchId: batch.id,
          status: MediaEnhancementStatus.pending,
        },
        data: { status: MediaEnhancementStatus.cancelled },
      });
      cancelled = res.count;
    }

    this.logger.log(
      `Enhancement batch ${batch.id} cancelled by user ${user.id} — ${cancelled} pending enhancement(s) withdrawn`,
    );

    return { batchId: batch.id, status: 'cancelled' as const, cancelled };
  }

  private async loadBatch(
    batchId: string,
    user: RequestUser,
    role: CircleRole,
  ): Promise<MediaEnhancementBatch> {
    const batch = await this.prisma.mediaEnhancementBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) {
      throw new NotFoundException(`Enhancement batch ${batchId} not found`);
    }
    await this.circleMembership.assertCircleAccess(
      user.id,
      batch.circleId,
      user.permissions,
      role,
    );
    return batch;
  }

  /**
   * Per-batch status tally + newest row timestamp, from ONE groupBy over
   * media_enhancements. Nothing about a batch's progress is stored on the batch
   * row itself: there are no counter columns and no finalize job, so a count can
   * never drift from the rows it describes.
   */
  private async tallyBatches(batchIds: string[]): Promise<Map<string, BatchTally>> {
    const out = new Map<string, BatchTally>();
    if (batchIds.length === 0) return out;

    const groups = await this.prisma.mediaEnhancement.groupBy({
      by: ['batchId', 'status'],
      where: { batchId: { in: batchIds } },
      _count: { _all: true },
      _max: { updatedAt: true },
    });

    for (const g of groups) {
      if (!g.batchId) continue;
      const tally =
        out.get(g.batchId) ?? { counts: {} as Record<string, number>, maxUpdatedAt: null };
      tally.counts[g.status] = g._count._all;
      const max = g._max.updatedAt;
      if (max && (!tally.maxUpdatedAt || max > tally.maxUpdatedAt)) {
        tally.maxUpdatedAt = max;
      }
      out.set(g.batchId, tally);
    }
    return out;
  }

  /**
   * Project a batch into the BaseRun shape every other async-run backend emits
   * (workflow runs, trash-empty runs, review runs), so the web RunProgressPanel
   * and useRunPolling work against it with no new component.
   *
   * Every number is DERIVED from the row tally — see tallyBatches.
   *
   *  - succeeded = ready | applied | discarded | expired. All four mean the
   *    render completed successfully; what the human did with it afterwards is
   *    a separate axis from whether the batch's work succeeded.
   *  - skipped   = cancelled (withdrawn before any render ran).
   *
   * STATUS KEYS OFF "no rows remain pending/processing", NEVER off
   * processedCount === matchedCount. MediaEnhancement.mediaItemId is
   * onDelete: Cascade, so hard-deleting a photo mid-batch removes its
   * enhancement row and SHRINKS the work set — under a counter-equality check
   * the batch would sit at `running` forever. This is the exact failure mode
   * documented for review_runs at schema.prisma:2036-2043.
   *
   * A batch with zero rows (nothing was eligible) therefore renders as a
   * terminal `completed`, not a stuck `running`.
   */
  private serializeBatch(batch: MediaEnhancementBatch, tally: BatchTally) {
    const c = tally.counts;
    const n = (s: MediaEnhancementStatus) => c[s] ?? 0;

    const pending = n(MediaEnhancementStatus.pending);
    const processing = n(MediaEnhancementStatus.processing);
    const succeededCount =
      n(MediaEnhancementStatus.ready) +
      n(MediaEnhancementStatus.applied) +
      n(MediaEnhancementStatus.discarded) +
      n(MediaEnhancementStatus.expired);
    const failedCount = n(MediaEnhancementStatus.failed);
    const skippedCount = n(MediaEnhancementStatus.cancelled);

    const matchedCount = pending + processing + succeededCount + failedCount + skippedCount;
    const processedCount = succeededCount + failedCount + skippedCount;

    const inFlight = pending + processing > 0;
    let status: 'running' | 'completed' | 'completed_with_errors' | 'cancelled';
    if (batch.cancelledAt) {
      status = 'cancelled';
    } else if (!inFlight) {
      status = failedCount > 0 ? 'completed_with_errors' : 'completed';
    } else {
      status = 'running';
    }

    return {
      id: batch.id,
      circleId: batch.circleId,
      status,
      matchedCount,
      processedCount,
      succeededCount,
      failedCount,
      skippedCount,
      // Batch creation is synchronous (there is no evaluating phase), so the
      // batch's own createdAt IS its start time.
      startedById: batch.createdById,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      startedAt: batch.createdAt,
      finishedAt: status === 'running' ? null : tally.maxUpdatedAt ?? batch.updatedAt,
      lastError: batch.lastError,
      // Batch-specific extras, outside the BaseRun contract.
      requestedCount: batch.requestedCount,
      queuedCount: batch.queuedCount,
      skipped: batch.skipped ?? null,
      params: batch.params ?? {},
      source: batch.source,
      cancelledAt: batch.cancelledAt,
    };
  }

  /**
   * Verify circle access, then confirm every id is a live member of circleId.
   *
   * Deliberately a private re-implementation of MediaService.assertAllInCircle
   * (which is private and in another module); the shape and the error message
   * are kept identical so the two stay recognisably the same guard.
   */
  private async assertAllInCircle(
    ids: string[],
    circleId: string,
    user: RequestUser,
    role: 'viewer' | 'collaborator',
  ): Promise<void> {
    await this.circleMembership.assertCircleAccess(
      user.id,
      circleId,
      user.permissions,
      role as CircleRole,
    );

    const uniqueIds = [...new Set(ids)];
    const found = await this.prisma.mediaItem.findMany({
      where: { id: { in: uniqueIds }, circleId, deletedAt: null },
      select: { id: true },
    });

    if (found.length !== uniqueIds.length) {
      const foundSet = new Set(found.map((f) => f.id));
      const missing = uniqueIds.filter((id) => !foundSet.has(id));
      throw new NotFoundException(
        `MediaItems not found or not accessible: ${missing.join(', ')}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/media/enhancements — cross-item hub listing (issue #201)
  // ---------------------------------------------------------------------------

  /**
   * Paginated, cross-item listing of a circle's enhancements — the data behind
   * the AI Enhancements hub.
   *
   * Three things this method is deliberately careful about:
   *
   *  1. **BigInt never reaches the serializer.** `enhancedSize` and the source
   *     object's `size` are Prisma `BigInt` columns and `JSON.stringify` throws
   *     on a JS BigInt (see the repo-wide gotcha in CLAUDE.md), so both are
   *     emitted as decimal STRINGS — matching signOriginal/signStaging.
   *
   *  2. **No N+1 signing.** Every source item for the page is loaded in ONE
   *     `mediaItem.findMany`, and every source thumbnail key on the page is
   *     signed by exactly ONE `signThumbsBatched` call. Staged objects (the
   *     enhanced result and, since #203, its thumbnail derivative) are signed
   *     directly instead: they deliberately have no `StorageObject` row, which
   *     is what `signThumbsBatched` resolves providers from. They go through a
   *     per-`provider|bucket` provider cache, so a page of N rows resolves at
   *     most one provider per distinct destination, not N — and unlike
   *     `signThumbsBatched` it costs no extra query at all.
   *
   *     Since #203 the card-sized `enhanced.thumbnailUrl` points at that
   *     thumbnail derivative rather than the full-resolution staged object; the
   *     full-resolution URL is still returned, as `enhanced.previewUrl`.
   *
   *  3. **`expiresAt` is computed server-side** from `updatedAt` +
   *     `pictureEnhancement.retentionHours`, read ONCE per request, and is
   *     returned only for the two statuses the purge job actually reaps
   *     (`ready` / `failed`) — so the client never has to know the retention
   *     setting to render a countdown.
   */
  async listEnhancements(query: ListEnhancementsQuery, user: RequestUser) {
    const { circleId, page, pageSize, sortBy, sortOrder } = query;

    await this.circleMembership.assertCircleAccess(
      user.id,
      circleId,
      user.permissions,
      CircleRole.viewer,
    );

    const statuses = resolveStatusFilter(query.status);
    // Served by the existing @@index([circleId, status]) on media_enhancements.
    const where: Prisma.MediaEnhancementWhereInput = {
      circleId,
      ...(statuses ? { status: { in: statuses } } : {}),
      // Optional batch narrowing (issue #421), served by @@index([batchId]).
      ...(query.batchId ? { batchId: query.batchId } : {}),
    };

    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.mediaEnhancement.findMany({
        where,
        // `id` tiebreak keeps paging deterministic when two rows share the
        // same createdAt/updatedAt (a bulk enqueue can produce ties).
        orderBy: [{ [sortBy]: sortOrder }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          createdBy: {
            select: { id: true, displayName: true, providerDisplayName: true },
          },
        },
      }),
      this.prisma.mediaEnhancement.count({ where }),
    ]);

    // Read the retention setting ONCE for the whole page, not per row.
    const retentionHours =
      (await this.systemSettings.getSettingValue<number>(
        'pictureEnhancement.retentionHours',
      )) ?? 168;

    // ONE query for every source item on the page.
    const mediaItemIds = [...new Set(rows.map((r) => r.mediaItemId))];
    const items = mediaItemIds.length
      ? await this.prisma.mediaItem.findMany({
          where: { id: { in: mediaItemIds } },
          select: {
            id: true,
            metadata: true,
            originalFilename: true,
            capturedAt: true,
            width: true,
            height: true,
            storageObject: { select: { size: true } },
          },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    // ONE batched signing call for every thumbnail key on the page.
    const keyToUrl = await this.thumbnails.signThumbsBatched(
      items
        .map((i) => this.thumbnails.extractThumbKey(i.metadata))
        .filter((k): k is string => k !== null),
    );

    // Staged bytes: resolve each distinct provider|bucket once for the page.
    const providerCache = new Map<
      string,
      Awaited<ReturnType<StorageProviderResolver['getProviderFor']>>
    >();
    const signStaged = async (
      provider: string,
      bucket: string | null,
      key: string,
    ): Promise<string | null> => {
      const cacheKey = `${provider}|${bucket ?? ''}`;
      try {
        let resolved = providerCache.get(cacheKey);
        if (!resolved) {
          resolved = await this.resolver.getProviderFor(provider, bucket);
          providerCache.set(cacheKey, resolved);
        }
        return await resolved.getSignedDownloadUrl(key);
      } catch (err) {
        // A single unsignable staged object must not fail the whole page.
        this.logger.warn(
          `listEnhancements: failed to sign staged key ${key} (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
    };

    const data = [];
    for (const row of rows) {
      const item = itemById.get(row.mediaItemId) ?? null;
      const thumbKey = item ? this.thumbnails.extractThumbKey(item.metadata) : null;

      // Prefer the live item dims (what buildComparePayload compares against),
      // falling back to the snapshot taken when the enhancement was created —
      // which is the only source left once a `replace` has mutated the item.
      const originalWidth = item?.width ?? row.originalWidth;
      const originalHeight = item?.height ?? row.originalHeight;

      // Only a `ready` row still owns staged bytes; every other status has had
      // them promoted, discarded, or reaped (mirrors buildComparePayload).
      const hasStaged =
        row.status === MediaEnhancementStatus.ready &&
        !!row.stagingStorageKey &&
        !!row.stagingProvider;

      data.push({
        id: row.id,
        mediaItemId: row.mediaItemId,
        status: row.status,
        decision: row.decision,
        model: row.model,
        params: row.params ?? {},
        original: {
          thumbnailUrl: thumbKey ? keyToUrl.get(thumbKey) ?? null : null,
          width: originalWidth,
          height: originalHeight,
          // BigInt -> string (JSON.stringify throws on BigInt).
          size:
            item?.storageObject?.size != null
              ? item.storageObject.size.toString()
              : null,
        },
        enhanced: {
          // A REAL thumbnail derivative (issue #203) — null for a row staged
          // before #203, or one whose best-effort thumbnail render failed.
          thumbnailUrl:
            hasStaged && row.stagingThumbnailKey
              ? await signStaged(
                  row.stagingProvider!,
                  row.stagingBucket,
                  row.stagingThumbnailKey,
                )
              : null,
          // Full-resolution staged bytes, under an honest name. Clients fall
          // back to this when `thumbnailUrl` is null, and the compare view uses
          // it directly.
          previewUrl: hasStaged
            ? await signStaged(
                row.stagingProvider!,
                row.stagingBucket,
                row.stagingStorageKey!,
              )
            : null,
          width: hasStaged ? row.enhancedWidth : null,
          height: hasStaged ? row.enhancedHeight : null,
          // BigInt -> string (JSON.stringify throws on BigInt).
          size: hasStaged && row.enhancedSize != null ? row.enhancedSize.toString() : null,
        },
        downscaled:
          !!originalWidth &&
          !!originalHeight &&
          !!row.enhancedWidth &&
          !!row.enhancedHeight &&
          row.enhancedWidth * row.enhancedHeight < originalWidth * originalHeight,
        // Only ready/failed rows are purge candidates, so only they expire.
        expiresAt:
          row.status === MediaEnhancementStatus.ready ||
          row.status === MediaEnhancementStatus.failed
            ? new Date(row.updatedAt.getTime() + retentionHours * 3_600_000)
            : null,
        lastError: row.lastError ?? null,
        resultMediaItemId: row.resultMediaItemId,
        sourceFilename: item?.originalFilename ?? null,
        capturedAt: item?.capturedAt ?? null,
        createdBy: row.createdBy
          ? {
              id: row.createdBy.id,
              name:
                row.createdBy.displayName ?? row.createdBy.providerDisplayName ?? null,
            }
          : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }

    return {
      items: data,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // GET /api/media/:id/enhance/:enhancementId  and  GET /api/media/:id/enhance
  // ---------------------------------------------------------------------------

  async getEnhancement(
    mediaItemId: string,
    enhancementId: string,
    user: RequestUser,
  ) {
    const row = await this.loadRowForItem(mediaItemId, enhancementId, user, 'viewer');
    return { data: await this.buildComparePayload(mediaItemId, row) };
  }

  async getLatestEnhancement(mediaItemId: string, user: RequestUser) {
    const mediaItem = await this.assertItemAccess(mediaItemId, user, 'viewer');
    const row = await this.prisma.mediaEnhancement.findFirst({
      where: { mediaItemId: mediaItem.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      return { data: null };
    }
    return { data: await this.buildComparePayload(mediaItemId, row) };
  }

  private async buildComparePayload(
    mediaItemId: string,
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
  ) {
    const base: Record<string, unknown> = {
      id: row.id,
      status: row.status,
      model: row.model,
      params: row.params ?? {},
    };

    if (row.status === MediaEnhancementStatus.failed) {
      base['lastError'] = row.lastError ?? null;
    }

    // Signed URLs + dimension deltas only meaningful once ready.
    if (row.status === MediaEnhancementStatus.ready && row.stagingStorageKey) {
      const original = await this.signOriginal(mediaItemId);
      const enhanced = await this.signStaging(row);
      const downscaled =
        !!original.width &&
        !!original.height &&
        !!row.enhancedWidth &&
        !!row.enhancedHeight &&
        row.enhancedWidth * row.enhancedHeight < original.width * original.height;
      return {
        ...base,
        original,
        enhanced,
        downscaled,
      };
    }

    return base;
  }

  private async signOriginal(mediaItemId: string): Promise<CompareSection> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        width: true,
        height: true,
        storageObject: {
          select: { storageKey: true, storageProvider: true, bucket: true, size: true },
        },
      },
    });
    if (!item?.storageObject) {
      return { url: null, width: item?.width ?? null, height: item?.height ?? null, size: null };
    }
    const provider = await this.resolver.getProviderFor(
      item.storageObject.storageProvider,
      item.storageObject.bucket,
    );
    const url = await provider.getSignedDownloadUrl(item.storageObject.storageKey);
    return {
      url,
      width: item.width,
      height: item.height,
      size: item.storageObject.size != null ? item.storageObject.size.toString() : null,
    };
  }

  private async signStaging(
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
  ): Promise<CompareSection> {
    if (!row.stagingStorageKey || !row.stagingProvider) {
      return {
        url: null,
        width: row.enhancedWidth,
        height: row.enhancedHeight,
        size: row.enhancedSize != null ? row.enhancedSize.toString() : null,
      };
    }
    const provider = await this.resolver.getProviderFor(row.stagingProvider, row.stagingBucket);
    const url = await provider.getSignedDownloadUrl(row.stagingStorageKey);
    return {
      url,
      width: row.enhancedWidth,
      height: row.enhancedHeight,
      size: row.enhancedSize != null ? row.enhancedSize.toString() : null,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/media/:id/enhance/:enhancementId/apply
  // ---------------------------------------------------------------------------

  async applyEnhancement(
    mediaItemId: string,
    enhancementId: string,
    decision: 'keep_both' | 'replace',
    user: RequestUser,
  ) {
    const row = await this.loadRowForItem(mediaItemId, enhancementId, user, 'collaborator');

    if (row.status !== MediaEnhancementStatus.ready || !row.stagingStorageKey) {
      throw new BadRequestException('Enhancement is not ready to apply');
    }

    if (decision === 'keep_both') {
      return this.applyKeepBoth(mediaItemId, row, user);
    }
    return this.applyReplace(mediaItemId, row, user);
  }

  private async applyKeepBoth(
    mediaItemId: string,
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
    user: RequestUser,
  ) {
    const source = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        type: true,
        source: true,
        capturedAt: true,
        capturedAtOffset: true,
        cameraMake: true,
        cameraModel: true,
        originalFilename: true,
        takenLat: true,
        takenLng: true,
        takenAltitude: true,
        geoCountry: true,
        geoCountryCode: true,
        geoAdmin1: true,
        geoCanonicalCountry: true,
        geoCanonicalAdmin1: true,
        geoCanonicalLocality: true,
        geoAdmin2: true,
        geoLocality: true,
        geoPlaceName: true,
        geoSource: true,
        geocodedAt: true,
        coordSource: true,
        metadata: true,
      },
    });
    if (!source) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    // Download the staged enhanced bytes.
    const stagingProvider = await this.resolver.getProviderFor(
      row.stagingProvider!,
      row.stagingBucket,
    );
    const bytes = await streamToBuffer(await stagingProvider.download(row.stagingStorageKey!));

    // Promote the bytes to a fresh permanent object on the ACTIVE provider so
    // the new item owns its own storage (independent of the purge-swept staging
    // key).
    const { id: activeProviderId, provider: activeProvider } =
      await this.resolver.getActiveProvider();
    const enhancedFilename = this.suffixFilename(source.originalFilename);
    const storageKey = `uploads/${Date.now()}/${randomUUID()}.jpg`;
    await activeProvider.upload(storageKey, Readable.from(bytes), {
      mimeType: 'image/jpeg',
      contentLength: bytes.length,
    });

    const newObject = await this.prisma.storageObject.create({
      data: {
        name: enhancedFilename,
        size: BigInt(bytes.length),
        mimeType: 'image/jpeg',
        storageKey,
        storageProvider: activeProviderId,
        bucket: activeProvider.getBucket(),
        status: 'pending',
        uploadedById: user.id,
      },
    });

    // Carry the source item's own metadata onto the enhanced copy (spec §5.2),
    // then layer the breadcrumb on top — same merge ORDER as applyReplace
    // (existing first, breadcrumb last, so the breadcrumb always wins).
    //
    // Unlike applyReplace — which mutates the SAME item, and so legitimately
    // keeps that item's derived state — keep_both mints a BRAND-NEW item with
    // its own storage object and its own processing lifecycle, so inherited
    // derived state would be actively wrong here. inheritableMetadata() drops
    // it; see that helper for the exact rule.
    const mergedMeta: Record<string, unknown> = {
      ...inheritableMetadata(source.metadata),
      _aiEnhanced: {
        model: row.model,
        at: new Date().toISOString(),
        enhancementId: row.id,
        fromId: source.id,
      },
      _enhancedFrom: source.id,
    };

    const newItem = await this.prisma.mediaItem.create({
      data: {
        storageObjectId: newObject.id,
        addedById: user.id,
        circleId: source.circleId,
        type: MediaType.photo,
        source: source.source,
        originalFilename: enhancedFilename,
        capturedAt: source.capturedAt,
        capturedAtOffset: source.capturedAtOffset,
        cameraMake: source.cameraMake,
        cameraModel: source.cameraModel,
        orientation: 1,
        width: row.enhancedWidth,
        height: row.enhancedHeight,
        takenLat: source.takenLat,
        takenLng: source.takenLng,
        takenAltitude: source.takenAltitude,
        geoCountry: source.geoCountry,
        geoCountryCode: source.geoCountryCode,
        geoAdmin1: source.geoAdmin1,
        // Location Grouping (issue #373): the canonical columns are copied
        // alongside their raw counterparts, not re-resolved — the new item is a
        // byte-for-byte location clone of the source, so re-running the resolver
        // could only introduce a divergence between two items that must agree.
        geoCanonicalCountry: source.geoCanonicalCountry,
        geoCanonicalAdmin1: source.geoCanonicalAdmin1,
        geoCanonicalLocality: source.geoCanonicalLocality,
        geoAdmin2: source.geoAdmin2,
        geoLocality: source.geoLocality,
        geoPlaceName: source.geoPlaceName,
        geoSource: source.geoSource,
        geocodedAt: source.geocodedAt,
        coordSource: source.coordSource,
        contentHash: null,
        metadata: mergedMeta as Prisma.InputJsonValue,
      },
    });

    // Re-derive width/height/size/contentHash + thumbnails from the enhanced
    // bytes via the standard reprocess pipeline.
    await this.recoveryService.reprocessObjectNow(newObject);
    try {
      await this.metadataSync.syncFromStorageObject(newObject.id);
    } catch (err) {
      this.logger.warn(
        `keep_both: metadata sync failed for new object ${newObject.id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // In-app AI-Enhanced marker (system tag).
    await this.applySystemTag(newItem.id, source.circleId, user.id);

    // Standard upload-time enrichment (tagging/faces/etc), idempotent.
    await this.mediaEnrichment.enqueueUploadEnrichment({
      id: newItem.id,
      type: MediaType.photo,
      circleId: source.circleId,
      deletedAt: null,
    });

    // Delete the staging bytes now that they are promoted, and finalize the row.
    await this.deleteStaging(row);
    await this.prisma.mediaEnhancement.update({
      where: { id: row.id },
      data: {
        status: MediaEnhancementStatus.applied,
        decision: MediaEnhancementDecision.keep_both,
        resultMediaItemId: newItem.id,
        stagingStorageKey: null,
        stagingThumbnailKey: null,
      },
    });

    await this.writeAudit(user.id, mediaItemId, {
      enhancementId: row.id,
      decision: 'keep_both',
      resultMediaItemId: newItem.id,
      model: row.model,
    });

    this.logger.log(
      `Enhancement ${row.id} applied (keep_both) — new MediaItem ${newItem.id} from ${mediaItemId}`,
    );

    return { data: { id: newItem.id, status: 'applied', decision: 'keep_both' } };
  }

  private async applyReplace(
    mediaItemId: string,
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
    user: RequestUser,
  ) {
    const settings = await this.systemSettings.getSettings();
    const enhCfg = settings.pictureEnhancement;

    if (enhCfg && enhCfg.allowReplace === false) {
      throw new BadRequestException('Replace is disabled by administrator policy');
    }

    const source = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        width: true,
        height: true,
        metadata: true,
        storageObject: true,
      },
    });
    if (!source || !source.storageObject) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    // Downscale-block policy.
    const downscaled =
      !!source.width &&
      !!source.height &&
      !!row.enhancedWidth &&
      !!row.enhancedHeight &&
      row.enhancedWidth * row.enhancedHeight < source.width * source.height;
    if (enhCfg?.blockReplaceOnDownscale === true && downscaled) {
      throw new BadRequestException(
        'Replace is blocked because the enhanced image is lower resolution than the original',
      );
    }

    const storageObject = source.storageObject;

    // Download staged bytes and overwrite the ORIGINAL key on its own provider.
    const stagingProvider = await this.resolver.getProviderFor(
      row.stagingProvider!,
      row.stagingBucket,
    );
    const bytes = await streamToBuffer(await stagingProvider.download(row.stagingStorageKey!));

    const objectProvider = await this.resolver.getProviderFor(
      storageObject.storageProvider,
      storageObject.bucket,
    );
    await objectProvider.upload(storageObject.storageKey, Readable.from(bytes), {
      mimeType: 'image/jpeg',
      contentLength: bytes.length,
    });

    // Merge the AI-enhanced breadcrumb into existing metadata.
    const existingMeta =
      (source.metadata as Record<string, unknown> | null) ?? {};
    const mergedMeta: Record<string, unknown> = {
      ...existingMeta,
      _aiEnhanced: {
        model: row.model,
        at: new Date().toISOString(),
        enhancementId: row.id,
      },
    };

    // Null the contentHash so reprocess recomputes it from the new bytes.
    await this.prisma.$transaction([
      this.prisma.storageObject.update({
        where: { id: storageObject.id },
        data: { size: BigInt(bytes.length), mimeType: 'image/jpeg' },
      }),
      this.prisma.mediaItem.update({
        where: { id: source.id },
        data: {
          contentHash: null,
          orientation: 1,
          width: row.enhancedWidth,
          height: row.enhancedHeight,
          metadata: mergedMeta as Prisma.InputJsonValue,
        },
      }),
    ]);

    // Regenerate thumbnails + re-derive dims/hash from the new bytes.
    let status = 'failed';
    const refreshed = await this.prisma.storageObject.findUnique({
      where: { id: storageObject.id },
    });
    let width = row.enhancedWidth ?? source.width ?? 0;
    let height = row.enhancedHeight ?? source.height ?? 0;
    if (refreshed) {
      await this.recoveryService.reprocessObjectNow(refreshed);
      const after = await this.prisma.storageObject.findUnique({
        where: { id: storageObject.id },
        select: { status: true },
      });
      status = after?.status ?? 'unknown';
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: source.id },
        select: { width: true, height: true },
      });
      width = item?.width ?? width;
      height = item?.height ?? height;
    }

    // In-app AI-Enhanced marker.
    await this.applySystemTag(source.id, source.circleId, user.id);

    // Rotation/regeneration invalidates face boxes — best-effort re-enqueue.
    await this.reenqueueFaceDetection(source.id, source.circleId);

    // Delete staging bytes, finalize row.
    await this.deleteStaging(row);
    await this.prisma.mediaEnhancement.update({
      where: { id: row.id },
      data: {
        status: MediaEnhancementStatus.applied,
        decision: MediaEnhancementDecision.replace,
        stagingStorageKey: null,
        stagingThumbnailKey: null,
      },
    });

    await this.writeAudit(user.id, mediaItemId, {
      enhancementId: row.id,
      decision: 'replace',
      model: row.model,
      status,
    });

    this.logger.log(
      `Enhancement ${row.id} applied (replace) on MediaItem ${mediaItemId} — status=${status} ${width}x${height}`,
    );

    return { data: { status, width, height } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/media/:id/enhance/:enhancementId/discard
  // ---------------------------------------------------------------------------

  async discardEnhancement(
    mediaItemId: string,
    enhancementId: string,
    user: RequestUser,
  ): Promise<void> {
    const row = await this.loadRowForItem(mediaItemId, enhancementId, user, 'collaborator');
    await this.deleteStaging(row);
    await this.prisma.mediaEnhancement.update({
      where: { id: row.id },
      data: {
          status: MediaEnhancementStatus.discarded,
          stagingStorageKey: null,
          stagingThumbnailKey: null,
        },
    });
    this.logger.log(`Enhancement ${row.id} discarded for MediaItem ${mediaItemId}`);
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private async assertItemAccess(
    mediaItemId: string,
    user: RequestUser,
    required: 'viewer' | 'collaborator',
  ) {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
    });
    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }
    await this.circleMembership.assertCircleAccess(
      user.id,
      mediaItem.circleId,
      user.permissions,
      required as CircleRole,
    );
    return mediaItem;
  }

  private async loadRowForItem(
    mediaItemId: string,
    enhancementId: string,
    user: RequestUser,
    required: 'viewer' | 'collaborator',
  ) {
    await this.assertItemAccess(mediaItemId, user, required);
    const row = await this.prisma.mediaEnhancement.findUnique({
      where: { id: enhancementId },
    });
    if (!row || row.mediaItemId !== mediaItemId) {
      throw new NotFoundException(`Enhancement ${enhancementId} not found`);
    }
    return row;
  }

  /**
   * Delete every staged byte the row owns — the full-resolution result AND its
   * thumbnail derivative (issue #203) — on the provider recorded at staging
   * time. Both keys live on the same provider/bucket, so one resolve covers
   * them; each delete is independent so a failure on one still attempts the
   * other. Best-effort throughout: an undeletable object must not block the
   * apply/discard/supersede that called this.
   *
   * Callers are responsible for nulling `stagingStorageKey` /
   * `stagingThumbnailKey` on the row afterwards.
   */
  private async deleteStaging(
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
  ): Promise<void> {
    if (!row.stagingProvider) return;
    const keys = [row.stagingStorageKey, row.stagingThumbnailKey].filter(
      (k): k is string => !!k,
    );
    if (keys.length === 0) return;

    let provider: Awaited<ReturnType<StorageProviderResolver['getProviderFor']>>;
    try {
      provider = await this.resolver.getProviderFor(
        row.stagingProvider,
        row.stagingBucket,
      );
    } catch (err) {
      this.logger.warn(
        `deleteStaging: failed to resolve provider ${row.stagingProvider} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    for (const key of keys) {
      try {
        await provider.delete(key);
      } catch (err) {
        this.logger.warn(
          `deleteStaging: failed to delete ${key} (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private async applySystemTag(
    mediaItemId: string,
    circleId: string,
    addedById: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const tag = await tx.tag.upsert({
        where: { circleId_name: { circleId, name: SYSTEM_TAG } },
        create: { addedById, circleId, name: SYSTEM_TAG },
        update: {},
      });
      await tx.mediaTag.upsert({
        where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId } },
        create: { tagId: tag.id, mediaItemId, source: MediaTagSource.system },
        update: {},
      });
      await tx.mediaTag.updateMany({
        where: { tagId: tag.id, mediaItemId, source: MediaTagSource.ai },
        data: { source: MediaTagSource.system },
      });
    });
  }

  private async reenqueueFaceDetection(
    mediaItemId: string,
    circleId: string,
  ): Promise<void> {
    try {
      const settings = await this.systemSettings.getSettings();
      const faceOn = settings.features?.['faceRecognition'] === true;
      const faceKilled = (process.env['FACE_AUTO_DETECT'] ?? 'true') === 'false';
      if (!faceOn || faceKilled) return;

      await this.enrichmentJobService.enqueue({
        type: 'face_detection',
        mediaItemId,
        circleId,
        reason: JobReason.rerun,
        priority: 0,
      });
      await this.prisma.mediaFaceStatus.upsert({
        where: { mediaItemId },
        create: { mediaItemId, status: MediaFaceStatusType.pending, faceCount: 0 },
        update: { status: MediaFaceStatusType.pending },
      });
    } catch (err) {
      this.logger.warn(
        `reenqueueFaceDetection failed for MediaItem ${mediaItemId} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async writeAudit(
    actorUserId: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId,
          action: 'media_enhancement:applied',
          targetType: 'media_item',
          targetId,
          meta: meta as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `writeAudit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private suffixFilename(name: string): string {
    const ext = extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    return `${base} (enhanced)${ext || '.jpg'}`;
  }

  // Re-exported for the handler so size/prompt resolution stays in one place.
  static resolveSize = closestSupportedSize;
  static sizeToDims = sizeToDims;
}

/**
 * Project a source MediaItem's `metadata` JSON down to the keys a NEW, derived
 * item may safely inherit (keep_both). Two families are dropped:
 *
 *  1. Any key beginning with `_` — the repo-wide marker for internal processing
 *     state (`_processing`, `_processingRetryCount`, `_thumbnailRepairAttempts`,
 *     `_thumbnailRepairExhausted`, `_processedAt`, and the `_aiEnhanced` /
 *     `_enhancedFrom` breadcrumbs themselves). The new object runs its own
 *     processing pipeline, so inheriting the source's counters/exhaustion flags
 *     would mis-report or suppress its recovery. Dropping a PRIOR `_aiEnhanced`
 *     breadcrumb is intentional too: the fresh breadcrumb layered on top records
 *     this item's immediate ancestor, which is the accurate provenance.
 *
 *  2. `thumbnailObjectId` / `thumbnailStorageKey` — not underscore-prefixed, but
 *     equally derived: they are the pointer the read path signs thumbnails from
 *     (MediaMetadataSyncService writes them). Copied over, the enhanced item
 *     would render the ORIGINAL's thumbnail, and — because ThumbnailRepairTask
 *     looks for `metadata->>'thumbnailStorageKey' IS NULL` — would be invisible
 *     to the repair sweep if its own sync ever failed. The reprocess +
 *     syncFromStorageObject that runs right after creation repopulates both.
 *
 * Everything else (user/EXIF-ish descriptive keys) carries over.
 */
function inheritableMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const DERIVED_KEYS = new Set(['thumbnailObjectId', 'thumbnailStorageKey']);
  return Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>).filter(
      ([key]) => !key.startsWith('_') && !DERIVED_KEYS.has(key),
    ),
  );
}
