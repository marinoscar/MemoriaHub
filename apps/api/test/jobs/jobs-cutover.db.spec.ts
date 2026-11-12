/**
 * Real-Postgres tier (RETRO-C1, #575): runs the cutover migration
 * (`20261108040000_cutover_enrichment_jobs_to_jobs`) on fixture rows of every shape and proves
 * what the rehearsal runbook claims: every `enrichment_jobs` row arrives in `jobs` with its
 * uuid, type, subject, status, org and dedup key as the mapping table says; the lifetime
 * rollup is folded into the platform table; the old table is renamed and released.
 *
 * It needs a database migrated to the state BEFORE this migration's effect is needed only for
 * the column types (`"JobStatus"`, `"MhLegacyJobStatus"`, `"MhLegacyJobReason"` and the shape of
 * `jobs`): the spec builds throw-away copies of the five tables in a scratch schema, so it can
 * run on a fully migrated database too. When no database is reachable, or it is not migrated
 * far enough to have the platform `jobs` table, the suite skips (logged).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { orgScoped } from '../helpers/org-scope';

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261108040000_cutover_enrichment_jobs_to_jobs',
  'migration.sql',
);

const MEDIA = '10000000-0000-4000-8000-000000000001';
const MEDIA_2 = '10000000-0000-4000-8000-000000000002';
const CIRCLE = '20000000-0000-4000-8000-000000000001';
const CIRCLE_2 = '20000000-0000-4000-8000-000000000002';
const NODE = '30000000-0000-4000-8000-000000000001';
const ORG = '40000000-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;

describe('enrichment_jobs -> jobs cutover migration (db)', () => {
  let client: Client | null = null;
  let schema = '';
  const ids = {
    mediaPending: randomUUID(),
    mediaPendingDup: randomUUID(),
    mediaRunning: randomUUID(),
    mediaSucceeded: randomUUID(),
    mediaFailed: randomUUID(),
    circlePending: randomUUID(),
    circleRunning: randomUUID(),
    migrationA: randomUUID(),
    migrationB: randomUUID(),
    globalPending: randomUUID(),
    globalSucceeded: randomUUID(),
    mediaNoCircle: randomUUID(),
    memoryA: randomUUID(),
    memoryB: randomUUID(),
  };

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await orgScoped(client!, { bypass: true }).query(sql, params)).rows;
  const job = async (id: string): Promise<Row> => (await q('SELECT * FROM jobs WHERE id = $1', [id]))[0]!;

  async function insertLegacy(row: {
    id: string;
    type: string;
    media?: string | null;
    circle?: string | null;
    status: string;
    reason?: string;
    priority?: number;
    attempts?: number;
    payload?: unknown;
    createdAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    node?: string | null;
    lease?: string | null;
    executor?: string | null;
    scheduledFor?: string | null;
    rateLimitHits?: number;
    lastError?: string | null;
    providerKey?: string | null;
  }): Promise<void> {
    await client!.query(
      `INSERT INTO enrichment_jobs (id, type, media_item_id, circle_id, status, reason, priority, attempts, payload,
         created_at, started_at, finished_at, claimed_by_node_id, lease_expires_at, executor, scheduled_for,
         rate_limit_hits, last_error, provider_key)
       VALUES ($1, $2, $3, $4, $5::"MhLegacyJobStatus", $6::"MhLegacyJobReason", $7, $8, $9::jsonb, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19)`,
      [
        row.id,
        row.type,
        row.media ?? null,
        row.circle ?? null,
        row.status,
        row.reason ?? 'upload',
        row.priority ?? 0,
        row.attempts ?? 0,
        row.payload === undefined ? null : JSON.stringify(row.payload),
        row.createdAt ?? '2026-01-01T00:00:00Z',
        row.startedAt ?? null,
        row.finishedAt ?? null,
        row.node ?? null,
        row.lease ?? null,
        row.executor ?? null,
        row.scheduledFor ?? null,
        row.rateLimitHits ?? 0,
        row.lastError ?? null,
        row.providerKey ?? null,
      ],
    );
  }

  beforeAll(async () => {
    const candidate = new Client({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB || 'appdb',
      connectionTimeoutMillis: 2000,
    });
    try {
      await candidate.connect();
      const have = await candidate.query(
        `SELECT to_regclass('public.jobs') AS jobs, to_regclass('public.job_stats_rollup') AS rollup,
                to_regclass('public.enrichment_jobs_legacy') AS legacy`,
      );
      if (!have.rows[0].jobs || !have.rows[0].rollup) {
        throw new Error('the platform jobs tables are missing: run `npm run prisma:migrate` first');
      }
    } catch (err) {
      console.warn(`Skipping jobs-cutover.db.spec: ${(err as Error).message}`);
      await candidate.end().catch(() => undefined);
      return;
    }
    client = candidate;

    schema = `c1_cutover_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);

    // Scratch copies of the five tables the migration touches. `public` still supplies the enum types.
    await q(`CREATE TABLE organizations (id uuid PRIMARY KEY, is_default boolean NOT NULL DEFAULT false)`);
    await q(`INSERT INTO organizations (id, is_default) VALUES ($1, true), ($2, false)`, [ORG, randomUUID()]);
    await q(`CREATE TABLE jobs (LIKE public.jobs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    await q(`ALTER TABLE jobs ADD PRIMARY KEY (id)`);
    await q(
      `CREATE UNIQUE INDEX jobs_active_dedup_uniq_idx ON jobs (dedup_key)
         WHERE status IN ('pending', 'running') AND dedup_key IS NOT NULL`,
    );
    await q(`CREATE TABLE job_stats_rollup (LIKE public.job_stats_rollup INCLUDING DEFAULTS)`);
    await q(`ALTER TABLE job_stats_rollup ADD PRIMARY KEY (type)`);
    await q(`CREATE TABLE mh_legacy_job_stats_rollup (LIKE public.job_stats_rollup INCLUDING DEFAULTS)`);
    await q(`ALTER TABLE mh_legacy_job_stats_rollup ADD PRIMARY KEY (type)`);
    // The old queue's table, as it stood: columns, the nine indexes the migration renames, the two partial
    // raw-SQL indexes it drops, and the three foreign keys it drops (stood in for by same-named CHECKs).
    await q(`CREATE TABLE enrichment_jobs (LIKE public.enrichment_jobs_legacy INCLUDING DEFAULTS)`);
    await q(`ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_pkey PRIMARY KEY (id)`);
    for (const [name, def] of [
      ['enrichment_jobs_claimed_by_node_id_idx', '(claimed_by_node_id)'],
      ['enrichment_jobs_created_at_idx', '(created_at DESC)'],
      ['enrichment_jobs_media_item_id_idx', '(media_item_id)'],
      ['enrichment_jobs_status_lease_expires_at_idx', '(status, lease_expires_at)'],
      ['enrichment_jobs_status_priority_created_at_idx', '(status, priority, created_at)'],
      ['enrichment_jobs_status_scheduled_for_priority_created_at_idx', '(status, scheduled_for, priority, created_at)'],
      ['enrichment_jobs_status_type_id_idx', '(status, type, id)'],
      ['enrichment_jobs_type_status_idx', '(type, status)'],
      ['enrichment_jobs_attempts_gt1_idx', '(attempts) WHERE attempts > 1'],
      ['enrichment_jobs_succeeded_duration_idx', '(finished_at, started_at, type) WHERE status = \'succeeded\''],
    ] as const) {
      await q(`CREATE INDEX ${name} ON enrichment_jobs ${def}`);
    }
    for (const fk of ['media_item_id', 'circle_id', 'claimed_by_node_id']) {
      await q(`ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_${fk}_fkey CHECK (true)`);
    }

    // ---- Fixture rows, one of every shape ------------------------------------------------------
    await insertLegacy({ id: ids.mediaPending, type: 'face_detection', media: MEDIA, circle: CIRCLE, status: 'pending', priority: 10, attempts: 0, payload: { a: 1 }, createdAt: '2026-01-01T00:00:00Z' });
    // A second pending row for the SAME (type, media item): a `skipDedup` enqueue of the old queue.
    await insertLegacy({ id: ids.mediaPendingDup, type: 'face_detection', media: MEDIA, circle: CIRCLE, status: 'pending', reason: 'rerun', createdAt: '2026-01-01T00:05:00Z' });
    await insertLegacy({ id: ids.mediaRunning, type: 'auto_tagging', media: MEDIA_2, circle: CIRCLE, status: 'running', attempts: 1, startedAt: '2026-01-02T00:00:00Z', node: NODE, lease: '2026-01-02T00:30:00Z', executor: 'node', providerKey: 'openai' });
    await insertLegacy({ id: ids.mediaSucceeded, type: 'geocode', media: MEDIA, circle: CIRCLE, status: 'succeeded', attempts: 1, startedAt: '2026-01-03T00:00:00Z', finishedAt: '2026-01-03T00:00:05Z', executor: 'server' });
    await insertLegacy({ id: ids.mediaFailed, type: 'metadata_extraction', media: MEDIA, circle: CIRCLE, status: 'failed', attempts: 3, lastError: 'boom', startedAt: '2026-01-03T00:00:00Z', finishedAt: '2026-01-03T00:00:09Z', executor: 'server', rateLimitHits: 2 });
    await insertLegacy({ id: ids.mediaNoCircle, type: 'geocode', media: MEDIA_2, circle: null, status: 'pending' });
    await insertLegacy({ id: ids.circlePending, type: 'face_auto_archive_sweep', circle: CIRCLE, status: 'pending', priority: 100, payload: { mode: 'sweep' } });
    await insertLegacy({ id: ids.circleRunning, type: 'location_inference', circle: CIRCLE_2, status: 'running', attempts: 1, startedAt: '2026-01-02T00:00:00Z', executor: 'server' });
    await insertLegacy({ id: ids.migrationA, type: 'storage_migration', status: 'pending', createdAt: '2026-01-01T01:00:00Z', payload: { runId: 'r', itemId: 'a' } });
    await insertLegacy({ id: ids.migrationB, type: 'storage_migration', status: 'pending', createdAt: '2026-01-01T01:00:01Z', payload: { runId: 'r', itemId: 'b' } });
    await insertLegacy({ id: ids.memoryA, type: 'memory_generation', circle: CIRCLE, status: 'pending', createdAt: '2026-01-01T02:00:00Z', payload: { backfill: true } });
    await insertLegacy({ id: ids.memoryB, type: 'memory_generation', circle: CIRCLE_2, status: 'pending', createdAt: '2026-01-01T02:00:01Z' });
    await insertLegacy({ id: ids.globalPending, type: 'trash_purge', status: 'pending', priority: 100 });
    await insertLegacy({ id: ids.globalSucceeded, type: 'job_history_purge', status: 'succeeded', finishedAt: '2026-01-04T00:00:00Z', startedAt: '2026-01-04T00:00:00Z' });

    await q(
      `INSERT INTO mh_legacy_job_stats_rollup (type, succeeded_count, failed_count, sum_duration_ms, duration_samples, updated_at)
       VALUES ('face_detection', 100, 5, 5000, 90, '2026-01-01T00:00:00Z'), ('auto_tagging', 10, 1, 800, 9, '2026-01-02T00:00:00Z')`,
    );
    await q(
      `INSERT INTO job_stats_rollup (type, succeeded_count, failed_count, sum_duration_ms, duration_samples, updated_at)
       VALUES ('auto_tagging', 2, 0, 200, 2, '2026-01-05T00:00:00Z')`,
    );

    // ---- The migration, exactly as `prisma migrate deploy` runs it -----------------------------
    await client.query(readFileSync(MIGRATION, 'utf8'));
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('copies every row once, with its uuid', async () => {
    if (!client) return;
    const legacy = await q('SELECT count(*)::int AS n FROM enrichment_jobs_legacy');
    const copied = await q('SELECT count(*)::int AS n FROM jobs');
    expect(legacy[0]!['n']).toBe(14);
    expect(copied[0]!['n']).toBe(14);
    const missing = await q(
      'SELECT count(*)::int AS n FROM enrichment_jobs_legacy e WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = e.id AND j.type = e.type)',
    );
    expect(missing[0]!['n']).toBe(0);
  });

  it('maps a media-item job: subject, circle into the payload, org, reason and priority', async () => {
    if (!client) return;
    const row = await job(ids.mediaPending);
    expect(row).toMatchObject({
      type: 'face_detection',
      subject_type: 'media_item',
      subject_id: MEDIA,
      status: 'pending',
      reason: 'upload',
      priority: 10,
      org_id: ORG,
      claim_token: null,
      trace_context: null,
    });
    expect(row['payload']).toEqual({ a: 1, circleId: CIRCLE });
  });

  it('a media-item job without a circle keeps a null payload', async () => {
    if (!client) return;
    expect((await job(ids.mediaNoCircle))['payload']).toBeNull();
  });

  it('maps a circle job to subject circle with its own payload, and a global job to no subject and no org', async () => {
    if (!client) return;
    expect(await job(ids.circlePending)).toMatchObject({ subject_type: 'circle', subject_id: CIRCLE, org_id: ORG });
    expect((await job(ids.circlePending))['payload']).toEqual({ mode: 'sweep' });
    expect(await job(ids.globalPending)).toMatchObject({ subject_type: null, subject_id: null, org_id: null });
  });

  it('turns a running job into a pending one: attempt kept, start, claim and lease cleared', async () => {
    if (!client) return;
    expect(await job(ids.mediaRunning)).toMatchObject({
      status: 'pending',
      attempts: 1,
      started_at: null,
      claimed_by_node_id: null,
      lease_expires_at: null,
      executor: null,
      provider_key: 'openai',
    });
    expect(await job(ids.circleRunning)).toMatchObject({ status: 'pending', started_at: null, executor: null });
  });

  it('keeps terminal rows as they were', async () => {
    if (!client) return;
    expect(await job(ids.mediaSucceeded)).toMatchObject({ status: 'succeeded', attempts: 1, executor: 'server' });
    expect((await job(ids.mediaSucceeded))['finished_at']).not.toBeNull();
    expect(await job(ids.mediaFailed)).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: 'boom',
      rate_limit_hits: 2,
    });
  });

  it('gives the dedup key to the OLDEST active row of each (type, subject) only', async () => {
    if (!client) return;
    expect((await job(ids.mediaPending))['dedup_key']).toBe(`face_detection:media_item:${MEDIA}`);
    // the second pending row for the same item (an old skipDedup enqueue) keeps NULL: it is exempt from the index
    expect((await job(ids.mediaPendingDup))['dedup_key']).toBeNull();
    // the same for the global skipDedup batch and for the two memory jobs of different circles
    expect((await job(ids.migrationA))['dedup_key']).toBe('storage_migration::');
    expect((await job(ids.migrationB))['dedup_key']).toBeNull();
    expect((await job(ids.memoryA))['dedup_key']).toBe(`memory_generation:circle:${CIRCLE}`);
    expect((await job(ids.memoryB))['dedup_key']).toBe(`memory_generation:circle:${CIRCLE_2}`);
    // a converted running row is active too
    expect((await job(ids.mediaRunning))['dedup_key']).toBe(`auto_tagging:media_item:${MEDIA_2}`);
    // a terminal row never holds a key
    expect((await job(ids.mediaSucceeded))['dedup_key']).toBeNull();
  });

  it('the active-dedup index now collapses a new enqueue onto a migrated row', async () => {
    if (!client) return;
    await expect(
      client.query(
        `INSERT INTO jobs (id, type, subject_type, subject_id, dedup_key, status, reason, created_at)
         VALUES ($1, 'face_detection', 'media_item', $2, $3, 'pending', 'upload', now())`,
        [randomUUID(), MEDIA, `face_detection:media_item:${MEDIA}`],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('folds the lifetime rollup into the platform table, adding counts where both had the type', async () => {
    if (!client) return;
    const rows = await q('SELECT * FROM job_stats_rollup ORDER BY type');
    const byType = Object.fromEntries(rows.map((r) => [r['type'] as string, r]));
    expect(byType['face_detection']).toMatchObject({ succeeded_count: 100, failed_count: 5, duration_samples: 90 });
    expect(byType['auto_tagging']).toMatchObject({ succeeded_count: 12, failed_count: 1, duration_samples: 11 });
    expect(Number(byType['auto_tagging']!['sum_duration_ms'])).toBe(1000);
    expect((byType['auto_tagging']!['updated_at'] as Date).toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect((await q(`SELECT to_regclass('mh_legacy_job_stats_rollup') AS t`))[0]!['t']).toBeNull();
  });

  it('retires the old table: renamed, claims released, foreign keys and partial indexes gone', async () => {
    if (!client) return;
    expect((await q(`SELECT to_regclass('enrichment_jobs') AS t`))[0]!['t']).toBeNull();
    const claimed = await q(
      'SELECT count(*)::int AS n FROM enrichment_jobs_legacy WHERE claimed_by_node_id IS NOT NULL OR lease_expires_at IS NOT NULL',
    );
    expect(claimed[0]!['n']).toBe(0);
    const indexes = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'enrichment_jobs_legacy'`, [schema])).map(
      (r) => r['indexname'] as string,
    );
    expect(indexes.sort()).toEqual(
      [
        'enrichment_jobs_legacy_claimed_by_node_id_idx',
        'enrichment_jobs_legacy_created_at_idx',
        'enrichment_jobs_legacy_media_item_id_idx',
        'enrichment_jobs_legacy_pkey',
        'enrichment_jobs_legacy_status_lease_expires_at_idx',
        'enrichment_jobs_legacy_status_priority_created_at_idx',
        'enrichment_jobs_legacy_status_scheduled_for_priority_create_idx',
        'enrichment_jobs_legacy_status_type_id_idx',
        'enrichment_jobs_legacy_type_status_idx',
      ].sort(),
    );
    const constraints = await q(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'enrichment_jobs_legacy'::regclass AND contype IN ('c', 'f')`,
    );
    expect(constraints).toEqual([]);
  });

  it('every renamed index fits the 63-character identifier limit (Postgres truncates, Prisma must agree)', async () => {
    if (!client) return;
    const names = await q(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'enrichment_jobs_legacy'`, [schema]);
    for (const { indexname } of names) expect((indexname as string).length).toBeLessThanOrEqual(63);
  });
});
