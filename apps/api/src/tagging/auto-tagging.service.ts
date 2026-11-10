import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { MediaTagSource, MediaTagStatusType, MediaType } from '@prisma/client';
import { Readable } from 'stream';
import { autoTaggingResultSchema, type AutoTaggingResult } from '@memoriahub/enrichment-compute/dto';
import { PrismaService } from '../prisma/prisma.service';
import { AiService, type AiContentPart } from '@marinoscar/platform-api/ai';
import { MEMORIAHUB_AI_FEATURES } from '../ai-port/ai-features';
import { assertEmbeddingDimensions, asJobError, aiRateLimit, systemScope, visionCallOptions } from '../ai-port/ai-calls';
import { MemoriaHubAiSettings } from '../ai-port/memoriahub-ai-settings';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '@marinoscar/platform-api/storage';
import { StorageProviderResolver } from '../platform/storage/storage-provider.resolver';
import { prepareImageForProcessing } from '../media-processing/image-orientation.util';
import { detectImageMime } from './image-mime.util';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import type { MediaJobContext } from '../platform/jobs/media-item-job';
import { MediaTouchService } from '../media/media-touch.service';

/**
 * System prompt sent alongside every tagging vision call. Extracted to a
 * module-level constant so `AutoTaggingService.buildPrompt` (shared by the
 * in-process compute path AND the node transient-credentials endpoint,
 * NodesService.getJobCredentials) can hand back the EXACT same prompt a node
 * would use — no duplicated prompt-string construction between the two call
 * sites.
 */
const AUTO_TAGGING_SYSTEM_PROMPT =
  'You are an image analysis assistant. Your job is to analyze the given image and return a JSON object with two keys: "tags" and "description". ' +
  '"tags" must be a JSON array of strings — each string must exactly match one of the labels in the provided allowed list; return an empty array if none apply. ' +
  '"description" must be a brief 1-3 sentence description of the photo. ' +
  'Respond with ONLY a JSON object with those two keys — no explanation, no code fences, no extra text.';

/**
 * Maximum image dimension (long edge) before downscaling.
 * 1568px matches Anthropic's auto-downscale threshold — anything larger
 * is rescaled server-side anyway, so we pay the token cost without
 * benefiting from higher resolution. OpenAI is also fine at this size.
 * Overridable via TAG_MAX_IMAGE_DIM env var.
 */
const TAG_MAX_DIM = parseInt(process.env['TAG_MAX_IMAGE_DIM'] ?? '1568', 10);

/**
 * Hard cap on base64-encoded image bytes sent to vision providers.
 * Anthropic enforces a ~5MB limit on image data; 4.5MB gives headroom.
 */
const MAX_IMAGE_BYTES = 4_500_000;

@Injectable()
export class AutoTaggingService {
  private readonly logger = new Logger(AutoTaggingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettings: MemoriaHubAiSettings,
    private readonly ai: AiService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly resolver: StorageProviderResolver,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly mediaTouch: MediaTouchService,
    // App metrics (RETRO-T3, #628): `app.media.tags.applied{source=ai}`. Optional for hand-built tests.
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  async processMediaItem(job: MediaJobContext): Promise<void> {
    // Guard: auto_tagging jobs must always have a mediaItemId (global/null jobs are not valid here)
    if (!job.mediaItemId) {
      throw new Error('auto_tagging job missing mediaItemId');
    }

    // a. Load MediaItem with storageObject, addedById, circleId, type, deletedAt
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: {
        id: true,
        circleId: true,
        type: true,
        deletedAt: true,
        addedById: true,
        storageObject: {
          select: { storageKey: true, storageProvider: true, bucket: true },
        },
      },
    });

    // b. Skip non-photo or soft-deleted
    if (!mediaItem || mediaItem.deletedAt || mediaItem.type !== MediaType.photo || !mediaItem.storageObject) {
      const reason = !mediaItem
        ? `MediaItem ${job.mediaItemId} not found`
        : mediaItem.deletedAt
          ? `MediaItem ${job.mediaItemId} is soft-deleted`
          : !mediaItem.storageObject
            ? `MediaItem ${job.mediaItemId} has no storageObject`
            : `MediaItem ${job.mediaItemId} is type ${mediaItem.type}, not photo`;
      this.logger.warn(`AutoTagJob ${job.id}: ${reason}; skipping`);
      // job.circleId is always a real string for auto_tagging per-item jobs
      // (the null guard above ensures global/null jobs never reach this handler)
      const circleId = mediaItem?.circleId ?? (job.circleId as string);
      await this.markFailed(job.mediaItemId, circleId, null, 'unknown', reason);
      return;
    }

    // c. Upsert mediaTagStatus → processing
    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId: job.mediaItemId },
      create: {
        mediaItemId: job.mediaItemId,
        circleId: mediaItem.circleId,
        status: MediaTagStatusType.processing,
        tagCount: 0,
      },
      update: {
        status: MediaTagStatusType.processing,
        lastError: null,
      },
    });

    // d. Read the tagging selection (`ai.features.tagging`)
    const selection = await this.aiSettings.selection('tagging');
    const provider = selection?.provider;
    const model = selection?.model;

    if (!provider || !model) {
      const errMsg = 'AI tagging provider or model not configured in system settings';
      this.logger.error(`AutoTagJob ${job.id}: ${errMsg}`);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, null, 'unknown', errMsg);
      return;
    }

    await this.enrichmentJobService.recordModel(job.id, provider, model);

    // e./f. The key is the platform's to resolve per call (`AiService`, AiKeyResolver): a missing or
    // disabled key surfaces from the call below as an `AiError`, which fails the item like any
    // other provider error.

    // g. Load enabled TagLabels
    const tagLabels = await this.prisma.tagLabel.findMany({
      where: { enabled: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    });

    // h. No labels → mark processed with tagCount=0
    if (tagLabels.length === 0) {
      this.logger.warn(`AutoTagJob ${job.id}: no enabled TagLabels found; skipping tagging`);
      await this.prisma.mediaTagStatus.upsert({
        where: { mediaItemId: job.mediaItemId },
        create: {
          mediaItemId: job.mediaItemId,
          circleId: mediaItem.circleId,
          status: MediaTagStatusType.processed,
          tagCount: 0,
          providerKey: provider,
          modelVersion: model,
          processedAt: new Date(),
        },
        update: {
          status: MediaTagStatusType.processed,
          tagCount: 0,
          providerKey: provider,
          modelVersion: model,
          processedAt: new Date(),
          lastError: null,
        },
      });
      return;
    }

    try {
      // i. Download image and prepare it (resolved via the object's own provider+bucket)
      const objectProvider = await this.resolver.getProviderFor(
        mediaItem.storageObject.storageProvider,
        mediaItem.storageObject.bucket,
      );
      const stream = await objectProvider.download(mediaItem.storageObject.storageKey);
      const buffer = await streamToBuffer(stream);

      const prepared = await prepareImageForProcessing(buffer, { maxDim: TAG_MAX_DIM });
      let imageBuffer: Buffer;
      let mimeType: string;

      if (prepared.width > 0) {
        // Happy path: sharp re-encoded to JPEG with EXIF orientation applied
        imageBuffer = prepared.buffer;
        mimeType = 'image/jpeg';
      } else {
        this.logger.warn(
          `AutoTagJob ${job.id}: image preprocessing failed; using raw buffer for MediaItem ${job.mediaItemId}`,
        );
        // Fallback: detect real MIME from magic bytes to avoid mislabeling
        const detected = detectImageMime(buffer);
        if (!detected) {
          const errMsg = 'Unsupported or undecodable image format (preprocessing failed)';
          this.logger.warn(`AutoTagJob ${job.id}: ${errMsg} for MediaItem ${job.mediaItemId}`);
          await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, errMsg);
          return;
        }
        imageBuffer = buffer;
        mimeType = detected;
      }

      // Byte-size guard: Anthropic rejects images > ~5 MB when base64-encoded
      if (imageBuffer.length > MAX_IMAGE_BYTES) {
        const errMsg = `Image exceeds maximum size for vision provider (${imageBuffer.length} bytes)`;
        this.logger.warn(`AutoTagJob ${job.id}: ${errMsg} for MediaItem ${job.mediaItemId}`);
        await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, errMsg);
        return;
      }

      // j2. Load assigned people names for this media item (needed to build
      // the prompt below; persistAutoTagging reloads this independently for
      // the node-result path, since a node has no preloaded context here).
      const faces = await this.prisma.face.findMany({
        where: {
          mediaItemId: job.mediaItemId,
          personId: { not: null },
          person: { deletedAt: null, mergedIntoId: null },
        },
        select: { person: { select: { name: true } } },
      });
      const peopleNames = [
        ...new Set(
          faces.map((f) => f.person?.name).filter((n): n is string => !!n),
        ),
      ];

      // k. Build prompt (shared with the node transient-credentials endpoint
      // — see NodesService.getJobCredentials — via buildPrompt below)
      const labelNames = tagLabels.map((t) => t.name);
      const { system: systemPrompt, prompt: userPrompt } = this.buildPrompt(labelNames, peopleNames);

      // COMPUTE half — same seam a distributed worker node uses locally
      // (with a transiently-fetched API key) via
      // @memoriahub/enrichment-compute/ai's callAnthropicVision.
      const { rawText } = await this.computeAutoTagging(imageBuffer, {
        model,
        system: systemPrompt,
        prompt: userPrompt,
        mimeType,
        provider,
        jobId: job.id,
      });

      // PERSIST half — identical whether the raw text came from this
      // in-process call or a node's POST /nodes/:id/jobs/:jobId/result.
      await this.persistAutoTagging(job, { rawText }, { providerKey: provider, modelVersion: model });
    } catch (err) {
      // p. On unexpected error from step i onwards: mark failed and rethrow (let worker retry)
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, errMsg);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // buildPrompt — shared prompt construction.
  //
  // Used by BOTH the in-process compute path above (processMediaItem) and the
  // node transient-credentials endpoint (NodesService.getJobCredentials) so a
  // distributed worker node receives the EXACT same system/user prompt the
  // server would have sent — no duplicated prompt-string construction.
  // ---------------------------------------------------------------------------

  buildPrompt(labelNames: string[], peopleNames: string[]): { system: string; prompt: string } {
    return {
      system: AUTO_TAGGING_SYSTEM_PROMPT,
      prompt: buildTaggingPrompt(labelNames, peopleNames),
    };
  }

  // ---------------------------------------------------------------------------
  // computeAutoTagging — COMPUTE half of the split.
  //
  // One vision call through the platform `AiService` (`forSystem`: a job has no acting user;
  // feature `media_tagging`): base64-encodes the already-prepared image and asks the model.
  // A provider 429/529 reaches the queue as the platform `RateLimitError` (the job is deferred,
  // no attempt charged). Server-only since RETRO-C4 (#590): AI rule 3, the key never leaves the API.
  // ---------------------------------------------------------------------------

  async computeAutoTagging(
    imageBuffer: Buffer,
    ctx: {
      model: string;
      system: string;
      prompt: string;
      mimeType: string;
      /** Provider id of the tagging selection. */
      provider: string;
      /** The queue job the call is made under (usage rows). */
      jobId?: string;
    },
  ): Promise<AutoTaggingResult> {
    const image: AiContentPart = {
      type: 'image',
      url: `data:${ctx.mimeType};base64,${imageBuffer.toString('base64')}`,
    };
    const text: AiContentPart = { type: 'text', text: ctx.prompt };

    try {
      const response = await this.ai
        .forSystem(systemScope(MEMORIAHUB_AI_FEATURES.mediaTagging, ctx.jobId))
        .respond({
          provider: ctx.provider,
          model: ctx.model,
          instructions: ctx.system,
          // Text first, then the image (the order the OpenAI path always sent); Anthropic reads the image first.
          input: [
            {
              type: 'message',
              role: 'user',
              content: ctx.provider === 'anthropic' ? [image, text] : [text, image],
            },
          ],
          ...visionCallOptions(ctx.provider, ctx.model),
        });
      return { rawText: response.outputText };
    } catch (providerErr) {
      throw asJobError(providerErr);
    }
  }

  // ---------------------------------------------------------------------------
  // persistAutoTagging — PERSIST half of the split.
  //
  // Self-contained: reloads the MediaItem, enabled TagLabel vocabulary, and
  // assigned people names itself. Used by processMediaItem above and by
  // VideoAutoTaggingService (one implementation of vocabulary validation).
  // ---------------------------------------------------------------------------

  async persistAutoTagging(
    job: MediaJobContext,
    result: AutoTaggingResult,
    used: { providerKey: string; modelVersion: string },
  ): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('auto_tagging job missing mediaItemId');
    }

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: { id: true, circleId: true, addedById: true, type: true },
    });
    if (!mediaItem) {
      throw new Error(`MediaItem ${job.mediaItemId} not found`);
    }

    const provider = used.providerKey;
    const model = used.modelVersion;

    const tagLabels = await this.prisma.tagLabel.findMany({
      where: { enabled: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    const labelNames = tagLabels.map((t) => t.name);

    // Parse and validate response
    const { tags: validRaw, description, parseOk } = parseAnalysisResult(result.rawText, labelNames);

    // Normalize case to match the original TagLabel name
    const labelByLower = new Map(labelNames.map((n) => [n.toLowerCase(), n]));
    const normalizedLabels = validRaw.map(
      (item) => labelByLower.get(item.toLowerCase()) ?? item,
    );

    // Resolve Tag rows OUTSIDE the transaction. Tag creation is an idempotent
    // find-or-create keyed on (circleId, name) and does not need to be atomic
    // with the mediaTag reconciliation below — keeping these upserts out of the
    // critical section shrinks the interactive transaction (which under
    // bulk-import load was blowing the tx timeout and starving the pool).
    const tagIdByLabel = new Map<string, string>();
    for (const labelName of normalizedLabels) {
      const tag = await this.prisma.tag.upsert({
        where: { circleId_name: { circleId: mediaItem.circleId, name: labelName } },
        create: { addedById: mediaItem.addedById, circleId: mediaItem.circleId, name: labelName },
        update: {},
      });
      tagIdByLabel.set(labelName, tag.id);
    }

    // Reconcile AI tags: remove stale AI tags, upsert current labels with source=ai.
    // Also persist description when parseOk is true.
    await this.prisma.$transaction(async (tx) => {
      // Remove AI-sourced tags no longer produced by the model
      await tx.mediaTag.deleteMany({
        where: {
          mediaItemId: mediaItem.id,
          source: MediaTagSource.ai,
          tag: { name: { notIn: normalizedLabels } },
        },
      });
      // Upsert current labels as AI tags (never downgrade manual to ai),
      // using the tagIds resolved before the transaction opened.
      for (const labelName of normalizedLabels) {
        const tagId = tagIdByLabel.get(labelName);
        if (!tagId) continue;
        await tx.mediaTag.upsert({
          where: { tagId_mediaItemId: { tagId, mediaItemId: mediaItem.id } },
          create: { tagId, mediaItemId: mediaItem.id, source: MediaTagSource.ai },
          update: {}, // do NOT downgrade manual tag to ai
        });
      }
      // Persist description only when parse succeeded
      if (parseOk) {
        await tx.mediaItem.update({
          where: { id: mediaItem.id },
          data: { description },
        });
      }
    });

    // The AI tag set this run left on the item (a re-run counts its set again).
    this.metrics?.add('mediaTagsApplied', normalizedLabels.length, { media_type: mediaItem.type, source: 'ai' });

    // Backup change feed (issue #310): the parseOk branch above already bumps
    // updatedAt via mediaItem.update; when the parse failed, only MediaTag rows
    // changed (stale-AI-tag deletion) and the item must be touched explicitly.
    if (!parseOk) {
      await this.mediaTouch.touchMediaItems([mediaItem.id]);
    }

    // Best-effort embedding — must not fail the tagging job. Reloads people
    // names independently since a node-result call has no preloaded context.
    const faces = await this.prisma.face.findMany({
      where: {
        mediaItemId: mediaItem.id,
        personId: { not: null },
        person: { deletedAt: null, mergedIntoId: null },
      },
      select: { person: { select: { name: true } } },
    });
    const peopleNames = [
      ...new Set(faces.map((f) => f.person?.name).filter((n): n is string => !!n)),
    ];
    await this.embedAndStore(mediaItem.id, mediaItem.circleId, description, normalizedLabels, peopleNames, job.id);

    // Upsert mediaTagStatus → processed
    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId: job.mediaItemId },
      create: {
        mediaItemId: job.mediaItemId,
        circleId: mediaItem.circleId,
        status: MediaTagStatusType.processed,
        providerKey: provider,
        modelVersion: model,
        tagCount: normalizedLabels.length,
        processedAt: new Date(),
      },
      update: {
        status: MediaTagStatusType.processed,
        providerKey: provider,
        modelVersion: model,
        tagCount: normalizedLabels.length,
        processedAt: new Date(),
        lastError: null,
      },
    });

    this.logger.log(
      `AutoTagJob ${job.id}: assigned ${normalizedLabels.length} tag(s) to MediaItem ${job.mediaItemId} using ${provider}/${model}`,
    );
  }

  /**
   * Generate a text embedding from the description, tags, and people names,
   * then upsert it into the media_item_embedding table.
   *
   * This is best-effort: any error is logged and swallowed — embedding failures
   * must NOT flip mediaTagStatus to failed or rethrow.
   */
  private async embedAndStore(
    mediaItemId: string,
    circleId: string,
    description: string | null,
    tagNames: string[],
    peopleNames: string[],
    jobId?: string,
  ): Promise<void> {
    try {
      // A video's transcript (epic #452, issue #454) joins the same embedding
      // text as description/tags/people. That is the ENTIRE "make speech
      // searchable" change — no new search field, index, or endpoint —
      // `semanticQuery` starts matching spoken content for free. Photos never
      // have a transcript row, so this read is a miss on the photo path.
      //
      // Isolated try/catch rather than relying on the outer one: a failed
      // transcript read must degrade to "no transcript", not to "no
      // embedding at all", which is what falling through to the outer catch
      // would silently do.
      const transcriptText = await this.readTranscriptText(mediaItemId);

      // Build text from all available signals
      const text = [description, ...tagNames, ...peopleNames, transcriptText]
        .filter(Boolean)
        .join('. ');
      if (!text) {
        return;
      }

      // Resolve the embedding selection (`ai.features.embedding`)
      const embeddingConfig = await this.aiSettings.selection('embedding');
      if (!embeddingConfig) {
        this.logger.warn(
          `AutoTagging embedAndStore: no embedding provider/model configured; skipping embedding for MediaItem ${mediaItemId}`,
        );
        return;
      }

      const { provider: embProvider, model: embModel } = embeddingConfig;

      // Generate the embedding through the platform `AiService` (feature `semantic_embedding`);
      // a model that answers another size than `media_item_embedding` holds is refused.
      const result = await this.ai
        .forSystem(systemScope(MEMORIAHUB_AI_FEATURES.semanticEmbedding, jobId))
        .embed({ provider: embProvider, model: embModel, input: text });
      const embedding = result.vectors[0] ?? [];
      assertEmbeddingDimensions(embedding, embModel);

      // Store via parameterized raw SQL to handle the pgvector column type
      const vectorLiteral = `[${embedding.join(',')}]`;
      await this.prisma.$executeRaw`
        INSERT INTO media_item_embedding (media_item_id, circle_id, embedding, model, updated_at)
        VALUES (${mediaItemId}::uuid, ${circleId}::uuid, ${vectorLiteral}::vector, ${embModel}, now())
        ON CONFLICT (media_item_id) DO UPDATE
          SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, updated_at = now()`;

      this.logger.log(
        `AutoTagging embedAndStore: stored ${embedding.length}-d embedding for MediaItem ${mediaItemId} using ${embProvider}/${embModel}`,
      );
    } catch (err) {
      // Re-throw rate-limit errors so the worker defers the entire tagging job
      // rather than silently dropping the embedding and marking it processed.
      const rl = aiRateLimit(err);
      if (rl) throw rl;

      this.logger.warn(
        `AutoTagging embedAndStore: embedding failed for MediaItem ${mediaItemId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      // Swallow the error — embedding failure must not fail the tagging job
    }
  }

  /**
   * Read a media item's transcript text, if one exists (epic #452, issue #454).
   *
   * Never throws: a transcript is an enrichment of the embedding text, not a
   * precondition for it, so any failure resolves to `null` and the embedding
   * proceeds from description/tags/people alone.
   */
  private async readTranscriptText(mediaItemId: string): Promise<string | null> {
    try {
      const row = await this.prisma.mediaTranscript.findUnique({
        where: { mediaItemId },
        select: { text: true },
      });
      return row?.text ?? null;
    } catch (err) {
      this.logger.warn(
        `AutoTagging embedAndStore: transcript lookup failed for MediaItem ${mediaItemId} — ${err instanceof Error ? err.message : String(err)}; embedding without it`,
      );
      return null;
    }
  }

  private async markFailed(
    mediaItemId: string,
    circleId: string,
    providerKey: string | null,
    modelVersion: string,
    error: string,
  ): Promise<void> {
    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status: MediaTagStatusType.failed,
        tagCount: 0,
        lastError: error,
        ...(providerKey ? { providerKey, modelVersion } : {}),
      },
      update: {
        status: MediaTagStatusType.failed,
        lastError: error,
        ...(providerKey ? { providerKey, modelVersion } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function buildTaggingPrompt(labelNames: string[], peopleNames: string[]): string {
  let prompt = `Analyze this image and return a JSON object with two keys: "tags" and "description".

"tags": an array of applicable labels from the following allowed list. Only choose labels that clearly apply. Return an empty array if none apply.
"description": a brief 1-3 sentence description of the photo.

Allowed labels:
${labelNames.join('\n')}

Example response: {"tags": ["label1", "label2"], "description": "Two adults and a child are seated around a picnic table. The yard is decorated with colorful balloons and streamers."}`;

  if (peopleNames.length > 0) {
    prompt += `\n\nThe following named people appear in this photo: ${peopleNames.join(', ')}. Mention them by name in the description where appropriate.`;
  }

  return prompt;
}

interface AnalysisResult {
  tags: string[];
  description: string | null;
  parseOk: boolean;
}

function parseAnalysisResult(raw: string, labelNames: string[]): AnalysisResult {
  const failure: AnalysisResult = { tags: [], description: null, parseOk: false };

  // Strip code fences if present
  const cleaned = raw.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();

  // Match a JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return failure;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return failure;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failure;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate and extract tags
  const rawTags = obj['tags'];
  const tagsArray: string[] = [];
  if (Array.isArray(rawTags)) {
    const labelNameSet = new Set(labelNames.map((n) => n.toLowerCase()));
    for (const item of rawTags) {
      if (typeof item === 'string' && labelNameSet.has(item.toLowerCase())) {
        tagsArray.push(item);
      }
    }
    // Deduplicate (case-insensitive)
    const seen = new Set<string>();
    const dedupedTags: string[] = [];
    for (const t of tagsArray) {
      const lower = t.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        dedupedTags.push(t);
      }
    }
    tagsArray.length = 0;
    tagsArray.push(...dedupedTags);
  }

  // Extract and validate description (trim, cap at 8192 chars, null if empty/missing)
  let description: string | null = null;
  if (typeof obj['description'] === 'string') {
    const trimmed = obj['description'].trim();
    description = trimmed.length > 0 ? trimmed.slice(0, 8192) : null;
  }

  return { tags: tagsArray, description, parseOk: true };
}
