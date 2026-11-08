import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { composeFilesForMode } from '@marinoscar/platform-infra';

// =============================================================================
// Talking to the deployed stack from an app step or check  (issue #577)
// =============================================================================
//
// The platform runs `docker compose` with the file list of its `vps` mode over
// `<deployRoot>/repo/infra/compose` (`.env` there is read by compose itself).
// The MemoriaHub steps and checks need the same invocation to run one-off
// commands in the `api` image, because that is the only place the database
// password legitimately exists: app steps are given a `DeployStepValues` that
// withholds secrets, so the probe runs INSIDE the container, which already has
// the whole `.env`, and prints one marker line. No secret passes through here.
// =============================================================================

/** `<deployRoot>/repo/infra/compose`: where the platform runs compose. */
export function composeDirOf(checkoutPath: string): string {
  return join(checkoutPath, 'infra', 'compose');
}

/** The `docker compose -f ...` prefix of the `vps` mode for this checkout. */
export function composePrefix(checkoutPath: string): string[] {
  const dir = composeDirOf(checkoutPath);
  let overlays: string[] = [];
  try {
    overlays = readdirSync(dir);
  } catch {
    overlays = [];
  }
  const files = composeFilesForMode('vps', { telemetry: false, overlays });
  return ['docker', 'compose', ...files.flatMap((file) => ['-f', file])];
}

/** The marker lines the probe script prints; tests and callers match on these. */
export const PGVECTOR_PRESENT = 'MEMORIAHUB_PGVECTOR=present';
export const PGVECTOR_ABSENT = 'MEMORIAHUB_PGVECTOR=absent';

/**
 * Node source run inside the `api` container: asks the configured database
 * whether the `vector` extension is installable (`pg_available_extensions`),
 * which is what the migrations' `CREATE EXTENSION vector` needs.
 */
export const PGVECTOR_PROBE_SCRIPT = `
const { Client } = require('pg');
const e = process.env;
const client = new Client({
  host: e.POSTGRES_HOST, port: Number(e.POSTGRES_PORT || 5432), user: e.POSTGRES_USER,
  password: e.POSTGRES_PASSWORD, database: e.POSTGRES_DB,
  ssl: e.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
(async () => {
  await client.connect();
  const r = await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
  console.log(r.rowCount > 0 ? '${PGVECTOR_PRESENT}' : '${PGVECTOR_ABSENT}');
  await client.end();
})().catch((err) => { console.error(String(err && err.message || err)); process.exit(2); });
`.trim();

/** argv of the probe, run with cwd = {@link composeDirOf}. */
export function pgvectorProbeArgv(checkoutPath: string): string[] {
  return [...composePrefix(checkoutPath), 'run', '--rm', '-T', '--no-deps', 'api', 'node', '-e', PGVECTOR_PROBE_SCRIPT];
}

/** The verdict of one probe run. */
export type PgvectorVerdict = { status: 'present' } | { status: 'absent' } | { status: 'unknown'; detail: string };

/** Reads the probe's output; anything but a marker is `unknown`, never a guess. */
export function readPgvectorVerdict(result: { exitCode: number; stdout: string; stderr: string }): PgvectorVerdict {
  if (result.stdout.includes(PGVECTOR_PRESENT)) return { status: 'present' };
  if (result.stdout.includes(PGVECTOR_ABSENT)) return { status: 'absent' };
  const tail = (result.stderr || result.stdout).trim().split('\n').slice(-1)[0] ?? '';
  return { status: 'unknown', detail: tail || `exit code ${result.exitCode}` };
}

export const PGVECTOR_REMEDY =
  'Use a PostgreSQL server that ships pgvector (managed services: enable the "vector" extension; self-hosted: ' +
  'install the pgvector package for your server version). The migrations run CREATE EXTENSION vector.';
