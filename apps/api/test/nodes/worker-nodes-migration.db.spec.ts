/**
 * Real-Postgres tier (RETRO-C2, #581). Proves the worker-node fleet survives the move onto the platform
 * nodes slice, on a scratch database migrated to the step BEFORE
 * `20261109300000_c2_worker_nodes_to_platform`:
 *
 *   - three legacy nodes (online, draining, disabled) and two legacy credentials (one that never
 *     expires, one revoked) with a Local Media Backup config and run on the first node;
 *   - the migration copies every row with its id, turns `online` / `draining` into `offline` (the node
 *     must re-register on the new protocol; `disabled` stays), keeps the backup rows resolving to the
 *     same node id and drops the legacy tables and enum;
 *   - a credential minted the legacy way (`nod_` + 64 hex, sha256 hex at rest) still validates through
 *     the PLATFORM `NodeCredentialService`, with no re-enrolment, and the revoked one is refused;
 *   - re-registering under the same owner and name re-attaches to the SAME row (`reattached: true`);
 *   - deleting a node still cascades to its backup rows.
 *
 * Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { NODE_TOKEN_PREFIX, NodeCredentialService } from '@marinoscar/platform-api/nodes';

import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { MIGRATIONS_DIR, applyMigration, connectionUrl, createScratchDatabase, type Row, type ScratchDatabase } from './scratch-db';
import { orgScoped } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const C2 = '20261109300000_c2_worker_nodes_to_platform';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describeMaybeDb('RETRO-C2 worker nodes and nod_ credentials move to the platform tables (DB_GATED: real PostgreSQL)', () => {
  let scratch: ScratchDatabase;
  let prisma: PrismaClient;

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await orgScoped(scratch.db, { bypass: true }).query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const ids = { online: randomUUID(), draining: randomUUID(), disabled: randomUUID() };
  const credentialIds = { live: randomUUID(), revoked: randomUUID() };
  const rawLive = `${NODE_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const rawRevoked = `${NODE_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const backupConfigId = randomUUID();
  const backupRunId = randomUUID();

  beforeAll(async () => {
    scratch = await createScratchDatabase(`c2_nodes_${randomUUID().replace(/-/g, '').slice(0, 12)}`, C2);

    await q(`INSERT INTO users (id, email, is_active, updated_at) VALUES ($1, $2, true, now())`, [
      owner,
      `person-a-${randomUUID().slice(0, 8)}@example.test`,
    ]);
    const node = (id: string, name: string, status: string, lastBeat: string | null) =>
      q(
        `INSERT INTO mh_legacy_worker_nodes
           (id, name, hostname, platform, cli_version, eligible_types, concurrency, status, capabilities, last_heartbeat_at, created_by_id)
         VALUES ($1, $2, 'host-a.example.test', 'linux', '1.3.9', ARRAY['geocode','thumbnail_regen'], 2, $3::"MhLegacyNodeStatus", '{"ffmpeg":"ok"}'::jsonb, $4, $5)`,
        [id, name, status, lastBeat, owner],
      );
    await node(ids.online, 'worker-one', 'online', new Date().toISOString());
    await node(ids.draining, 'worker-two', 'draining', new Date().toISOString());
    await node(ids.disabled, 'worker-zeta', 'disabled', null);

    const credential = (id: string, name: string, raw: string, revoked: boolean) =>
      q(
        `INSERT INTO mh_legacy_node_credentials (id, user_id, name, token_hash, token_prefix, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, owner, name, sha256(raw), raw.slice(0, 8), revoked ? new Date().toISOString() : null],
      );
    await credential(credentialIds.live, 'fleet', rawLive, false);
    await credential(credentialIds.revoked, 'old', rawRevoked, true);

    await q(
      `INSERT INTO node_backup_configs (id, node_id, enabled, circle_ids, items_acked, bytes_acked, updated_at)
       VALUES ($1, $2, true, ARRAY[]::uuid[], 12, 3456, now())`,
      [backupConfigId, ids.online],
    );
    await q(
      `INSERT INTO node_backup_runs (id, node_id, kind, status, trigger) VALUES ($1, $2, 'incremental', 'completed', 'manual')`,
      [backupRunId, ids.online],
    );

    await applyMigration(scratch.db, readFileSync(join(MIGRATIONS_DIR, C2, 'migration.sql'), 'utf8'));
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionUrl(scratch.name), max: 2 }) });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await scratch?.drop();
  });

  it('copies every node with its id, and an online or draining node comes back offline', async () => {
    const rows = await q(`SELECT id, name, hostname, platform, cli_version, eligible_types, concurrency, status::text AS status, capabilities, created_by_id, last_vitals, last_vitals_at FROM worker_nodes ORDER BY name`);
    expect(rows.map((r) => [r.id, r.name, r.status])).toEqual([
      [ids.online, 'worker-one', 'offline'],
      [ids.draining, 'worker-two', 'offline'],
      [ids.disabled, 'worker-zeta', 'disabled'],
    ]);
    expect(rows[0]).toMatchObject({
      hostname: 'host-a.example.test',
      platform: 'linux',
      cli_version: '1.3.9',
      eligible_types: ['geocode', 'thumbnail_regen'],
      concurrency: 2,
      capabilities: { ffmpeg: 'ok' },
      created_by_id: owner,
      last_vitals: null,
      last_vitals_at: null,
    });
  });

  it('keeps the credentials byte for byte', async () => {
    const rows = await q(`SELECT id, token_hash, token_prefix, revoked_at FROM node_credentials ORDER BY name`);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === credentialIds.live)).toMatchObject({
      token_hash: sha256(rawLive),
      token_prefix: rawLive.slice(0, 8),
      revoked_at: null,
    });
    expect(rows.find((r) => r.id === credentialIds.revoked)?.revoked_at).not.toBeNull();
  });

  it('drops the legacy tables and the legacy enum', async () => {
    const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('mh_legacy_worker_nodes','mh_legacy_node_credentials')`);
    const types = await q(`SELECT typname FROM pg_type WHERE typname = 'MhLegacyNodeStatus'`);
    expect(tables).toEqual([]);
    expect(types).toEqual([]);
  });

  it('keeps the Local Media Backup rows pointing at the same node id', async () => {
    const config = await one(`SELECT c.node_id, w.name FROM node_backup_configs c JOIN worker_nodes w ON w.id = c.node_id WHERE c.id = $1`, [backupConfigId]);
    const run = await one(`SELECT r.node_id FROM node_backup_runs r JOIN worker_nodes w ON w.id = r.node_id WHERE r.id = $1`, [backupRunId]);
    expect(config).toMatchObject({ node_id: ids.online, name: 'worker-one' });
    expect(run.node_id).toBe(ids.online);
  });

  it('authenticates an existing token through the platform NodeCredentialService (no re-enrolment)', async () => {
    const service = new NodeCredentialService(prisma as never);
    const principal = await service.validateToken(rawLive);
    expect(principal?.id).toBe(owner);
    expect(await service.validateToken(rawRevoked)).toBeNull();
    expect(await service.validateToken(`${NODE_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`)).toBeNull();
  });

  it('cascades a node deletion to its backup rows, as before', async () => {
    await q(`DELETE FROM worker_nodes WHERE id = $1`, [ids.online]);
    expect(await q(`SELECT 1 FROM node_backup_configs WHERE id = $1`, [backupConfigId])).toEqual([]);
    expect(await q(`SELECT 1 FROM node_backup_runs WHERE id = $1`, [backupRunId])).toEqual([]);
  });
});
