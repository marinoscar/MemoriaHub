import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const connectionString = process.env.DATABASE_URL || 'postgresql://memoriahub:memoriahub_dev@localhost:5432/memoriahub';

async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString });

  try {
    console.log('Running database migrations...');

    // Ensure migrations table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Get already applied migrations
    const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedMigrations = new Set(result.rows.map((row) => row.version));

    // Get migration files
    const migrationsDir = join(__dirname, '../src/infrastructure/database/migrations');
    const migrationFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Run pending migrations
    for (const file of migrationFiles) {
      const version = file.replace('.sql', '');

      if (appliedMigrations.has(version)) {
        console.log(`  Skipping ${version} (already applied)`);
        continue;
      }

      console.log(`  Applying ${version}...`);
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');

      try {
        await pool.query(sql);
        console.log(`  ✓ ${version} applied successfully`);
      } catch (error) {
        console.error(`  ✗ ${version} failed:`, error instanceof Error ? error.message : error);
        throw error;
      }
    }

    console.log('Migrations complete!');
  } finally {
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
