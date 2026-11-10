import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '@marinoscar/platform-api/ai';
import { PrismaService } from '../prisma/prisma.service';
import { MEMORIAHUB_AI_FEATURES } from '../ai-port/ai-features';
import { assertEmbeddingDimensions } from '../ai-port/ai-calls';
import { MemoriaHubAiSettings } from '../ai-port/memoriahub-ai-settings';

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettings: MemoriaHubAiSettings,
    private readonly ai: AiService,
  ) {}

  /**
   * Embed a query string for `userId` using the `semantic_embedding` feature (the model saved in
   * `ai.features.embedding`), through the platform `AiService`.
   * Returns null (graceful degradation) when:
   *   - No embedding feature is configured
   *   - The model does not return the 1536-d vectors `media_item_embedding` holds
   *   - Any error occurs during embedding (the key, the model, the kill switch, the provider)
   */
  async embedQuery(text: string, userId: string): Promise<number[] | null> {
    let config: { provider: string; model: string } | null = null;
    try {
      config = await this.aiSettings.selection('embedding');
    } catch (err) {
      this.logger.warn(`SemanticSearchService: failed to resolve embedding config: ${String(err)}`);
      return null;
    }

    if (!config) {
      this.logger.warn('SemanticSearchService: no embedding provider/model configured; skipping semantic search');
      return null;
    }

    try {
      const result = await this.ai
        .forUser(userId, { feature: MEMORIAHUB_AI_FEATURES.semanticEmbedding })
        .embed({ provider: config.provider, model: config.model, input: text });
      const vector = result.vectors[0] ?? [];
      assertEmbeddingDimensions(vector, config.model);
      return vector;
    } catch (err) {
      this.logger.warn(`SemanticSearchService: embedding failed for provider "${config.provider}": ${String(err)}`);
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
