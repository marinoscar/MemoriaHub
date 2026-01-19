import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgresql://memoriahub:memoriahub_dev@localhost:5432/memoriahub';

async function resetDatabase(): Promise<void> {
  const pool = new Pool({ connectionString });

  try {
    console.log('Resetting database...');

    // Drop all tables
    await pool.query(`
      DROP TABLE IF EXISTS audit_login_events CASCADE;
      DROP TABLE IF EXISTS user_settings CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS schema_migrations CASCADE;
      DROP TYPE IF EXISTS oauth_provider CASCADE;
    `);

    console.log('All tables dropped.');
    console.log('Run "npm run db:migrate" to recreate the schema.');
  } finally {
    await pool.end();
  }
}

resetDatabase().catch((error) => {
  console.error('Reset failed:', error);
  process.exit(1);
});
