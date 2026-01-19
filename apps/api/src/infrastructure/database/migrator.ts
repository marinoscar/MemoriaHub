import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './client.js';
import { logger } from '../logging/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Run all pending database migrations
 *
 * This function:
 * 1. Creates the schema_migrations table if it doesn't exist
 * 2. Reads all .sql files from the migrations directory
 * 3. Executes any migrations not yet applied (in order)
 * 4. Records each successful migration
 *
 * Migrations are idempotent - safe to run multiple times.
 */
export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');

  logger.info({ eventType: 'db.migrations.start' }, 'Starting database migrations');

  // Ensure migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);

  // Get list of already applied migrations
  const { rows: appliedMigrations } = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  const appliedSet = new Set(appliedMigrations.map((m) => m.version));

  // Read all migration files
  let migrationFiles: string[];
  try {
    migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort(); // Ensure alphabetical order (001_, 002_, etc.)
  } catch (error) {
    logger.warn(
      { eventType: 'db.migrations.nodir', path: migrationsDir },
      'Migrations directory not found, skipping migrations'
    );
    return;
  }

  // Run pending migrations
  let appliedCount = 0;
  for (const file of migrationFiles) {
    const version = file.replace('.sql', '');

    if (appliedSet.has(version)) {
      logger.debug(
        { eventType: 'db.migrations.skip', version },
        'Migration already applied, skipping'
      );
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    logger.info(
      { eventType: 'db.migrations.applying', version },
      `Applying migration: ${version}`
    );

    try {
      // Execute the migration
      await pool.query(sql);
      appliedCount++;

      logger.info(
        { eventType: 'db.migrations.applied', version },
        `Successfully applied migration: ${version}`
      );
    } catch (error) {
      logger.error(
        {
          eventType: 'db.migrations.error',
          version,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        `Failed to apply migration: ${version}`
      );
      throw error;
    }
  }

  if (appliedCount > 0) {
    logger.info(
      { eventType: 'db.migrations.complete', count: appliedCount },
      `Applied ${appliedCount} migration(s)`
    );
  } else {
    logger.info(
      { eventType: 'db.migrations.uptodate' },
      'Database schema is up to date'
    );
  }
}

/**
 * Check if the database has been initialized (has the users table)
 */
export async function isDatabaseInitialized(): Promise<boolean> {
  try {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'users'
      ) as exists
    `);
    return result.rows[0]?.exists === true;
  } catch {
    return false;
  }
}
