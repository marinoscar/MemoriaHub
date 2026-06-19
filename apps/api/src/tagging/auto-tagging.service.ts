import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaTagStatusType, MediaType } from '@prisma/client';
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
      const circleId = mediaItem?.circleId ?? job.circleId;
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

      // k. Build prompt and call analyzeImage
      const labelNames = tagLabels.map((t) => t.name);
      const userPrompt = buildTaggingPrompt(labelNames);
      const systemPrompt =
        'You are an image analysis assistant. Your job is to identify which labels from a provided list apply to the given image. Respond with ONLY a JSON array of strings — no explanation, no code fences, no extra text. Each string must exactly match one of the labels in the provided list. Return an empty array if none apply.';

      const raw = await aiProvider.analyzeImage(creds, {
        model,
        system: systemPrompt,
        prompt: userPrompt,
        imageBase64,
        mimeType,
      });

      // l. Parse and validate response
      const parsed = parseTagArray(raw);
      const labelNameSet = new Set(labelNames.map((n) => n.toLowerCase()));
      const validatedLabels = [
        ...new Set(
          parsed.filter((item) => labelNameSet.has(item.toLowerCase())),
        ),
      ];

      // Normalize case to match the original TagLabel name
      const labelByLower = new Map(labelNames.map((n) => [n.toLowerCase(), n]));
      const normalizedLabels = validatedLabels.map(
        (item) => labelByLower.get(item.toLowerCase()) ?? item,
      );

      // m. Upsert Tag and MediaTag for each validated label
      for (const labelName of normalizedLabels) {
        const tag = await this.prisma.tag.upsert({
          where: { circleId_name: { circleId: mediaItem.circleId, name: labelName } },
          create: { addedById: mediaItem.addedById, circleId: mediaItem.circleId, name: labelName },
          update: {},
        });
        await this.prisma.mediaTag.upsert({
          where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId: mediaItem.id } },
          create: { tagId: tag.id, mediaItemId: mediaItem.id },
          update: {},
        });
      }

      // n. Upsert mediaTagStatus → processed
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
      // o. On unexpected error from step i onwards: mark failed and rethrow (let worker retry)
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, errMsg);
      throw err;
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

function buildTaggingPrompt(labelNames: string[]): string {
  return `Analyze this image and return a JSON array of applicable labels from the following allowed list.
Only choose labels that clearly apply. Return ONLY the JSON array.

Allowed labels:
${labelNames.join('\n')}

Example response: ["label1", "label2"]`;
}

function parseTagArray(raw: string): string[] {
  const cleaned = raw.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}
