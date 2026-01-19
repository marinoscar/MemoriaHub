import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgresql://memoriahub:memoriahub_dev@localhost:5432/memoriahub';

async function seedDatabase(): Promise<void> {
  const pool = new Pool({ connectionString });

  try {
    console.log('Seeding database...');

    // Add any seed data here
    // For now, we don't need seed data as users are created via OAuth

    console.log('Seeding complete!');
  } finally {
    await pool.end();
  }
}

seedDatabase().catch((error) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});
