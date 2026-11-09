/**
 * Shared helpers of the RETRO-I2 (#569) circles-to-groups scripts. READ-ONLY:
 * nothing here writes. Connection: `--database <url>`, else DATABASE_URL, else
 * the POSTGRES_* variables (the same formula as apps/api/scripts/prisma-env.js).
 * No credential is ever printed.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The content tables of docs/platform-adoption/circles-to-groups.md §3, plus the raw `media_visual_embedding`. */
export const CONTENT_TABLES = [
  'media_items', 'albums', 'tags', 'people', 'faces', 'memories', 'media_item_embedding', 'media_geocode_status',
  'media_metadata_status', 'media_tag_status', 'media_transcripts', 'burst_groups', 'duplicate_groups',
  'location_suggestions', 'media_enhancements', 'media_enhancement_batches', 'review_runs', 'trash_empty_runs',
  'workflows', 'workflow_runs', 'media_visual_embedding',
];

/** Tables whose `circle_id` has no foreign key: a stale id falls back to the media item's circle. */
export const NO_CIRCLE_FK = new Set(['media_item_embedding', 'media_visual_embedding']);

export const ROLE_MAP = { circle_admin: 'admin', collaborator: 'editor', viewer: 'viewer' };

export function connectionString(argv) {
  const i = argv.indexOf('--database');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const e = process.env;
  const user = encodeURIComponent(e.POSTGRES_USER ?? 'postgres');
  const auth = e.POSTGRES_PASSWORD ? `${user}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` : user;
  const ssl = e.POSTGRES_SSL === 'true' ? '?sslmode=require' : '';
  return `postgresql://${auth}@${e.POSTGRES_HOST ?? 'localhost'}:${e.POSTGRES_PORT ?? '5432'}/${e.POSTGRES_DB ?? 'appdb'}${ssl}`;
}

/**
 * Opens a client in a READ ONLY transaction with the RLS bypass set (the content
 * tables are FORCE RLS after the migration; a connection that is not the
 * superuser would otherwise see no row).
 */
export async function connect(argv) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: connectionString(argv) });
  await client.connect();
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
  return {
    async rows(sql, params = []) {
      return (await client.query(sql, params)).rows;
    },
    async one(sql, params = []) {
      return (await client.query(sql, params)).rows[0];
    },
    async close() {
      await client.query('ROLLBACK');
      await client.end();
    },
  };
}

export async function hasColumn(db, table, column) {
  const row = await db.one(
    `SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return row !== undefined;
}
