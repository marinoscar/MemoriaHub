import type { IngestionEvent, FileSource, IngestionStatus } from '@memoriahub/shared';
import { query } from '../client.js';
import { logger } from '../../logging/logger.js';
import { getTraceId } from '../../logging/request-context.js';

/**
 * Database row type for ingestion events
 */
interface IngestionEventRow {
  id: string;
  asset_id: string;
  source: FileSource;
  client_info: Record<string, unknown>;
  trace_id: string;
  started_at: Date;
  completed_at: Date | null;
  status: IngestionStatus;
  error_message: string | null;
}

/**
 * Convert database row to IngestionEvent entity
 */
function rowToIngestionEvent(row: IngestionEventRow): IngestionEvent {
  return {
    id: row.id,
    assetId: row.asset_id,
    source: row.source,
    clientInfo: row.client_info || {},
    traceId: row.trace_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    errorMessage: row.error_message,
  };
}

/**
 * Input for creating an ingestion event
 */
export interface CreateIngestionEventInput {
  assetId: string;
  source: FileSource;
  clientInfo?: Record<string, unknown>;
  traceId?: string;
}

/**
 * Ingestion event repository implementation
 */
export class IngestionEventRepository {
  /**
   * Find ingestion event by ID
   */
  async findById(id: string): Promise<IngestionEvent | null> {
    const result = await query<IngestionEventRow>(
      'SELECT * FROM ingestion_events WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToIngestionEvent(result.rows[0]);
  }

  /**
   * Find ingestion events by asset ID
   */
  async findByAssetId(assetId: string): Promise<IngestionEvent[]> {
    const result = await query<IngestionEventRow>(
      'SELECT * FROM ingestion_events WHERE asset_id = $1 ORDER BY started_at DESC',
      [assetId]
    );

    return result.rows.map(rowToIngestionEvent);
  }

  /**
   * Create a new ingestion event
   */
  async create(input: CreateIngestionEventInput): Promise<IngestionEvent> {
    const traceId = input.traceId || getTraceId() || '';

    const result = await query<IngestionEventRow>(
      `INSERT INTO ingestion_events (asset_id, source, client_info, trace_id, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [
        input.assetId,
        input.source,
        JSON.stringify(input.clientInfo || {}),
        traceId,
      ]
    );

    const event = rowToIngestionEvent(result.rows[0]);

    logger.debug({
      eventType: 'ingestion.started',
      ingestionId: event.id,
      assetId: event.assetId,
      source: event.source,
      traceId,
    }, 'Ingestion event created');

    return event;
  }

  /**
   * Mark ingestion as completed
   */
  async complete(assetId: string): Promise<IngestionEvent | null> {
    const traceId = getTraceId();

    const result = await query<IngestionEventRow>(
      `UPDATE ingestion_events
       SET status = 'completed', completed_at = NOW()
       WHERE asset_id = $1 AND status = 'pending'
       RETURNING *`,
      [assetId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const event = rowToIngestionEvent(result.rows[0]);

    logger.info({
      eventType: 'ingestion.completed',
      ingestionId: event.id,
      assetId: event.assetId,
      durationMs: event.completedAt && event.startedAt
        ? event.completedAt.getTime() - event.startedAt.getTime()
        : null,
      traceId,
    }, 'Ingestion completed');

    return event;
  }

  /**
   * Mark ingestion as failed
   */
  async fail(assetId: string, errorMessage: string): Promise<IngestionEvent | null> {
    const traceId = getTraceId();

    const result = await query<IngestionEventRow>(
      `UPDATE ingestion_events
       SET status = 'failed', completed_at = NOW(), error_message = $2
       WHERE asset_id = $1 AND status = 'pending'
       RETURNING *`,
      [assetId, errorMessage]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const event = rowToIngestionEvent(result.rows[0]);

    logger.warn({
      eventType: 'ingestion.failed',
      ingestionId: event.id,
      assetId: event.assetId,
      errorMessage,
      traceId,
    }, 'Ingestion failed');

    return event;
  }

  /**
   * Get ingestion statistics for a time period
   */
  async getStats(
    startDate: Date,
    endDate: Date
  ): Promise<{
    total: number;
    completed: number;
    failed: number;
    pending: number;
    bySource: Record<FileSource, number>;
  }> {
    const result = await query<{ status: IngestionStatus; source: FileSource; count: string }>(
      `SELECT status, source, COUNT(*)::text as count
       FROM ingestion_events
       WHERE started_at >= $1 AND started_at <= $2
       GROUP BY status, source`,
      [startDate, endDate]
    );

    const stats = {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      bySource: { web: 0, webdav: 0, api: 0 } as Record<FileSource, number>,
    };

    for (const row of result.rows) {
      const count = parseInt(row.count, 10);
      stats.total += count;
      stats.bySource[row.source] = (stats.bySource[row.source] || 0) + count;

      if (row.status === 'completed') stats.completed += count;
      else if (row.status === 'failed') stats.failed += count;
      else if (row.status === 'pending') stats.pending += count;
    }

    return stats;
  }
}

// Export singleton instance
export const ingestionEventRepository = new IngestionEventRepository();
