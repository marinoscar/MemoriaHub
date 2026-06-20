import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderRegistry } from '../ai/providers/ai-provider.registry';

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
  ) {}

  /**
   * Embed a query string using the configured embedding provider + model.
   * Returns null (graceful degradation) when:
   *   - No embedding feature is configured
   *   - The provider does not implement embedText
   *   - Any error occurs during embedding
   */
  async embedQuery(text: string): Promise<number[] | null> {
    let config: { provider: string; model: string } | null = null;
    try {
      config = await this.aiSettings.resolveEmbeddingConfig();
    } catch (err) {
      this.logger.warn(`SemanticSearchService: failed to resolve embedding config: ${String(err)}`);
      return null;
    }

    if (!config) {
      this.logger.warn('SemanticSearchService: no embedding provider/model configured; skipping semantic search');
      return null;
    }

    const { provider: providerKey, model } = config;

    let creds: { apiKey: string; baseUrl?: string };
    try {
      creds = await this.aiSettings.resolveCredentials(providerKey);
    } catch (err) {
      this.logger.warn(`SemanticSearchService: failed to resolve credentials for provider "${providerKey}": ${String(err)}`);
      return null;
    }

    const provider = this.registry.get(providerKey);

    if (typeof provider.embedText !== 'function') {
      this.logger.warn(
        `SemanticSearchService: provider "${providerKey}" does not implement embedText; skipping semantic search`,
      );
      return null;
    }

    try {
      const vector = await provider.embedText(creds, model, text);
      return vector;
    } catch (err) {
      this.logger.warn(`SemanticSearchService: embedText failed for provider "${providerKey}": ${String(err)}`);
      return null;
    }
  }

  /**
   * Run a KNN cosine similarity query against media_item_embedding for the given circle.
   * Returns rows ordered by ascending distance (closest first).
   *
   * The vector literal is built from plain numbers so there is no SQL injection risk.
   * circleId and limit are passed as tagged-template parameters.
   */
  async knnMediaIds(
    circleId: string,
    queryVec: number[],
    limit: number,
  ): Promise<{ id: string; distance: number }[]> {
    const vectorLiteral = `[${queryVec.join(',')}]`;

    const rows = await this.prisma.$queryRaw<{ id: string; distance: unknown }[]>`
      SELECT e.media_item_id AS id, (e.embedding <=> ${vectorLiteral}::vector) AS distance
      FROM media_item_embedding e
      JOIN media_items m ON m.id = e.media_item_id
      WHERE e.circle_id = ${circleId}::uuid AND m.deleted_at IS NULL
      ORDER BY e.embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}`;

    return rows.map((row) => ({
      id: row.id,
      distance: Number(row.distance),
    }));
  }
}
