/**
 * A scratch PostgreSQL database for the real-Postgres node specs (RETRO-C2, #581): created beside
 * the configured one, migrated with the app's migration history the way `prisma migrate deploy`
 * would (optionally stopping BEFORE one migration), dropped afterwards.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

export type Row = Record<string, any>;

export function connection(database: string) {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database,
  };
}

export function connectionUrl(database: string): string {
  const c = connection(database);
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${database}`;
}

/** Applies one migration file the way `prisma migrate deploy` would. */
export async function applyMigration(client: Client, sql: string): Promise<void> {
  if (sql.includes('$$') || /^\s*BEGIN\s*;/im.test(sql)) {
    await client.query(sql);
    return;
  }
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) await client.query(statement);
}

export interface ScratchDatabase {
  readonly name: string;
  readonly admin: Client;
  readonly db: Client;
  drop(): Promise<void>;
}

/** Creates `name`, applies every migration (stopping before `stopBefore` when given). */
export async function createScratchDatabase(name: string, stopBefore?: string): Promise<ScratchDatabase> {
  const admin = new Client(connection(process.env.POSTGRES_DB || 'appdb'));
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const db = new Client(connection(name));
  await db.connect();
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    if (dir === stopBefore) break;
    await applyMigration(db, readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'));
  }
  return {
    name,
    admin,
    db,
    async drop() {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
