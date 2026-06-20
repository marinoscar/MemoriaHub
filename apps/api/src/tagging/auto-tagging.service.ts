import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaTagSource, MediaTagStatusType, MediaType } from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderRegistry } from '../ai/providers/ai-provider.registry';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { detectImageMime } from './image-mime.util';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { RateLimitError, parseRetryAfterMs } from '../enrichment/rate-limit.error';

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
    private readonly aiSettingsService: AiSettingsService,
    private readonly aiProviderRegistry: AiProviderRegistry,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  async processMediaItem(job: EnrichmentJob): Promise<void> {
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
          select: { storageKey: true },
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

    // d. Read AI tagging config from system settings
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taggingConfig = (row?.value as any)?.ai?.features?.tagging as
      | { provider?: string; model?: string }
      | undefined;

    const provider = taggingConfig?.provider;
    const model = taggingConfig?.model;

    if (!provider || !model) {
      const errMsg = 'AI tagging provider or model not configured in system settings';
      this.logger.error(`AutoTagJob ${job.id}: ${errMsg}`);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, null, 'unknown', errMsg);
      return;
    }

    await this.enrichmentJobService.recordModel(job.id, provider, model);

    // e. Resolve credentials — non-throwing gate
    let creds: { apiKey: string; baseUrl?: string };
    try {
      creds = await this.aiSettingsService.resolveCredentials(provider);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`AutoTagJob ${job.id}: failed to resolve credentials for provider ${provider}: ${errMsg}`);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, errMsg);
      return;
    }

    // f. Get provider instance
    const aiProvider = this.aiProviderRegistry.get(provider);

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
      // i. Download image and prepare it
      const stream = await this.storageProvider.download(mediaItem.storageObject.storageKey);
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

      // j. Convert to base64
      const imageBase64 = imageBuffer.toString('base64');

      // j2. Load assigned people names for this media item
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

      // k. Build prompt and call analyzeImage
      const labelNames = tagLabels.map((t) => t.name);
      const userPrompt = buildTaggingPrompt(labelNames, peopleNames);
      const systemPrompt =
        'You are an image analysis assistant. Your job is to analyze the given image and return a JSON object with three keys: "tags", "caption", and "description". ' +
        '"tags" must be a JSON array of strings — each string must exactly match one of the labels in the provided allowed list; return an empty array if none apply. ' +
        '"caption" must be a single-sentence caption for the photo. ' +
        '"description" must be a brief 1-3 sentence description of the photo. ' +
        'Respond with ONLY a JSON object with those three keys — no explanation, no code fences, no extra text.';

      let raw: string;
      try {
        raw = await aiProvider.analyzeImage(creds, {
          model,
          system: systemPrompt,
          prompt: userPrompt,
          imageBase64,
          mimeType,
        });
      } catch (providerErr) {
        // Surface provider-level 429 / rate-limit errors explicitly so the
        // worker routes them through the rate-limit deferral path instead of
        // the normal exponential-retry path.
        const e = providerErr as Record<string, unknown> | null;
        const httpStatus =
          typeof e?.['status'] === 'number' ? e['status'] : undefined;
        if (httpStatus === 429) {
          const retryHeader =
            typeof (e?.['headers'] as Record<string, unknown> | undefined)?.['retry-after'] === 'string'
              ? ((e?.['headers'] as Record<string, unknown>)['retry-after'] as string)
              : typeof (e?.['response'] as Record<string, unknown> | undefined)?.['headers'] === 'object'
                ? (((e?.['response'] as Record<string, unknown>)['headers'] as Record<string, unknown>)['retry-after'] as string | undefined)
                : undefined;
          const retryAfterMs = parseRetryAfterMs(retryHeader) ?? undefined;
          throw new RateLimitError(
            (typeof e?.['message'] === 'string' ? e['message'] : 'AI provider rate limit exceeded (429)'),
            retryAfterMs,
            provider,
          );
        }
        throw providerErr;
      }

      // l. Parse and validate response
      const labelNames2 = tagLabels.map((t) => t.name);
      const { tags: validRaw, caption, description, parseOk } = parseAnalysisResult(raw, labelNames2);

      // Normalize case to match the original TagLabel name
      const labelByLower = new Map(labelNames2.map((n) => [n.toLowerCase(), n]));
      const normalizedLabels = validRaw.map(
        (item) => labelByLower.get(item.toLowerCase()) ?? item,
      );

      // m. Reconcile AI tags: remove stale AI tags, upsert current labels with source=ai
      //    Also persist caption/description when parseOk is true.
      await this.prisma.$transaction(async (tx) => {
        // Remove AI-sourced tags no longer produced by the model
        await tx.mediaTag.deleteMany({
          where: {
            mediaItemId: mediaItem.id,
            source: MediaTagSource.ai,
            tag: { name: { notIn: normalizedLabels } },
          },
        });
        // Upsert current labels as AI tags (never downgrade manual to ai)
        for (const labelName of normalizedLabels) {
          const tag = await tx.tag.upsert({
            where: { circleId_name: { circleId: mediaItem.circleId, name: labelName } },
            create: { addedById: mediaItem.addedById, circleId: mediaItem.circleId, name: labelName },
            update: {},
          });
          await tx.mediaTag.upsert({
            where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId: mediaItem.id } },
            create: { tagId: tag.id, mediaItemId: mediaItem.id, source: MediaTagSource.ai },
            update: {}, // do NOT downgrade manual tag to ai
          });
        }
        // Persist caption and description only when parse succeeded
        if (parseOk) {
          await tx.mediaItem.update({
            where: { id: mediaItem.id },
            data: { caption, description },
          });
        }
      });

      // n. Best-effort embedding — must not fail the tagging job
      await this.embedAndStore(
        mediaItem.id,
        mediaItem.circleId,
        caption,
        description,
        normalizedLabels,
        peopleNames,
      );

      // o. Upsert mediaTagStatus → processed
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
    } catch (err) {
      // p. On unexpected error from step i onwards: mark failed and rethrow (let worker retry)
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, errMsg);
      throw err;
    }
  }

  /**
   * Generate a text embedding from the caption, description, tags, and people names,
   * then upsert it into the media_item_embedding table.
   *
   * This is best-effort: any error is logged and swallowed — embedding failures
   * must NOT flip mediaTagStatus to failed or rethrow.
   */
  private async embedAndStore(
    mediaItemId: string,
    circleId: string,
    caption: string | null,
    description: string | null,
    tagNames: string[],
    peopleNames: string[],
  ): Promise<void> {
    try {
      // Build text from all available signals
      const text = [caption, description, ...tagNames, ...peopleNames]
        .filter(Boolean)
        .join('. ');
      if (!text) {
        return;
      }

      // Resolve embedding config
      const embeddingConfig = await this.aiSettingsService.resolveEmbeddingConfig();
      if (!embeddingConfig) {
        this.logger.warn(
          `AutoTagging embedAndStore: no embedding provider/model configured; skipping embedding for MediaItem ${mediaItemId}`,
        );
        return;
      }

      const { provider: embProvider, model: embModel } = embeddingConfig;

      // Resolve credentials for embedding provider
      let embCreds: { apiKey: string; baseUrl?: string };
      try {
        embCreds = await this.aiSettingsService.resolveCredentials(embProvider);
      } catch (credErr) {
        this.logger.warn(
          `AutoTagging embedAndStore: failed to resolve credentials for embedding provider ${embProvider}: ${credErr instanceof Error ? credErr.message : String(credErr)}`,
        );
        return;
      }

      // Get provider instance and check embedText support
      const embProviderInstance = this.aiProviderRegistry.get(embProvider);
      if (typeof embProviderInstance.embedText !== 'function') {
        this.logger.warn(
          `AutoTagging embedAndStore: provider ${embProvider} does not support embedText; skipping embedding for MediaItem ${mediaItemId}`,
        );
        return;
      }

      // Generate embedding
      const embedding = await embProviderInstance.embedText(embCreds, embModel, text);

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
      this.logger.warn(
        `AutoTagging embedAndStore: embedding failed for MediaItem ${mediaItemId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      // Swallow the error — embedding failure must not fail the tagging job
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
  let prompt = `Analyze this image and return a JSON object with three keys: "tags", "caption", and "description".

"tags": an array of applicable labels from the following allowed list. Only choose labels that clearly apply. Return an empty array if none apply.
"caption": a short single-sentence caption for the photo.
"description": a brief 1-3 sentence description of the photo.

Allowed labels:
${labelNames.join('\n')}

Example response: {"tags": ["label1", "label2"], "caption": "A family gathering in a sunny backyard.", "description": "Two adults and a child are seated around a picnic table. The yard is decorated with colorful balloons and streamers."}`;

  if (peopleNames.length > 0) {
    prompt += `\n\nThe following named people appear in this photo: ${peopleNames.join(', ')}. Mention them by name in the description where appropriate.`;
  }

  return prompt;
}

interface AnalysisResult {
  tags: string[];
  caption: string | null;
  description: string | null;
  parseOk: boolean;
}

function parseAnalysisResult(raw: string, labelNames: string[]): AnalysisResult {
  const failure: AnalysisResult = { tags: [], caption: null, description: null, parseOk: false };

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

  // Extract and validate caption (trim, cap at 2048 chars, null if empty/missing)
  let caption: string | null = null;
  if (typeof obj['caption'] === 'string') {
    const trimmed = obj['caption'].trim();
    caption = trimmed.length > 0 ? trimmed.slice(0, 2048) : null;
  }

  // Extract and validate description (trim, cap at 8192 chars, null if empty/missing)
  let description: string | null = null;
  if (typeof obj['description'] === 'string') {
    const trimmed = obj['description'].trim();
    description = trimmed.length > 0 ? trimmed.slice(0, 8192) : null;
  }

  return { tags: tagsArray, caption, description, parseOk: true };
}
