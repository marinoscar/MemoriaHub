import pg from 'pg';
import { databaseConfig } from '../../config/index.js';
import { logger } from '../logging/logger.js';

const { Pool } = pg;

/**
 * PostgreSQL connection pool
 */
export const pool = new Pool({
  connectionString: databaseConfig.connectionString,
  max: databaseConfig.maxConnections,
  idleTimeoutMillis: databaseConfig.idleTimeoutMs,
  connectionTimeoutMillis: databaseConfig.connectionTimeoutMs,
});

// Log pool events
pool.on('connect', () => {
  logger.debug({ eventType: 'db.pool.connect' }, 'New client connected to pool');
});

pool.on('error', (err) => {
  logger.error({ eventType: 'db.pool.error', error: err.message }, 'Pool error');
});

pool.on('remove', () => {
  logger.debug({ eventType: 'db.pool.remove' }, 'Client removed from pool');
});

/**
 * Execute a query with logging
 */
export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug(
      {
        eventType: 'db.query',
        durationMs: duration,
        rowCount: result.rowCount,
      },
      'Query executed'
    );
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logger.error(
      {
        eventType: 'db.query.error',
        durationMs: duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Query failed'
    );
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient(): Promise<pg.PoolClient> {
  const client = await pool.connect();
  return client;
}

/**
 * Execute a function within a transaction
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check database connectivity
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully close the pool
 */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info({ eventType: 'db.pool.closed' }, 'Database pool closed');
}
