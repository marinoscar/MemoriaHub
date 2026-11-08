// =============================================================================
// MemoriaHub's db-backup registrations (RETRO-D4, #580)
// =============================================================================
//
// The restore gate `memoriahub-extensions` only ever READS (one SELECT on
// `pg_available_extensions`, never a CREATE, DROP, ALTER or rename); the `pg`
// client is spied on, so the test records exactly what the gate sends. The
// Android releases carry-over binds `$1` and orders the losing current row first;
// the legacy `db-backups/` prefix is registered with deployment scope.
// =============================================================================

import { Client } from 'pg';

import { restoreCarryOverRegistry, restoreGateRegistry } from '@marinoscar/platform-api/db-backup';
import { buildRestoreGateContext, describeRestoreGateConformance } from '@marinoscar/platform-api/db-backup/testing';
import { storageKeyPrefixRegistry } from '@marinoscar/platform-api/storage';

import {
  ANDROID_RELEASES_CARRY_OVER,
  LEGACY_DB_BACKUP_KEY_PREFIX,
  MEMORIAHUB_EXTENSIONS_GATE_ID,
  MEMORIAHUB_REQUIRED_EXTENSIONS,
  checkMemoriaHubExtensions,
} from './db-backup';

interface RecordedClient {
  host: string | undefined;
  port: number | undefined;
  user: string | undefined;
  database: string | undefined;
  queries: Array<{ text: string; values: unknown[] | undefined }>;
  ended: boolean;
}

const state: {
  clients: RecordedClient[];
  offered: string[];
  connectError: Error | null;
  queryError: Error | null;
} = { clients: [], offered: [], connectError: null, queryError: null };

function recordedFor(client: unknown): RecordedClient {
  const found = state.clients.find((entry) => (entry as unknown as { _client: unknown })._client === client);
  if (found) return found;
  const real = client as Pick<RecordedClient, 'host' | 'port' | 'user' | 'database'>;
  const created: RecordedClient = { host: real.host, port: real.port, user: real.user, database: real.database, queries: [], ended: false };
  Object.defineProperty(created, '_client', { value: client, enumerable: false });
  state.clients.push(created);
  return created;
}

beforeEach(() => {
  state.clients = [];
  state.offered = ['vector', 'plpgsql', 'uuid-ossp'];
  state.connectError = null;
  state.queryError = null;
  jest.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client) {
    recordedFor(this);
    if (state.connectError) throw state.connectError;
  } as never);
  jest.spyOn(Client.prototype, 'query').mockImplementation((async function (this: Client, text: string, values?: unknown[]) {
    recordedFor(this).queries.push({ text, values });
    if (state.queryError) throw state.queryError;
    const wanted = (values?.[0] ?? []) as string[];
    return { rows: state.offered.filter((name) => wanted.includes(name)).map((name) => ({ name })) };
  }) as never);
  jest.spyOn(Client.prototype, 'end').mockImplementation((async function (this: Client) {
    recordedFor(this).ended = true;
  }) as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Statements that would change the cluster; none may ever be sent. */
const WRITE_STATEMENT = /\b(create|drop|alter|rename|insert|update|delete|truncate|grant|revoke)\b/i;

describe('the memoriahub-extensions restore gate', () => {
  it('requires pgvector, the extension the embedding columns and HNSW indexes need', () => {
    expect([...MEMORIAHUB_REQUIRED_EXTENSIONS]).toEqual(['vector']);
  });

  it('has an id the registry accepts, and is registered', () => {
    expect(MEMORIAHUB_EXTENSIONS_GATE_ID).toBe('memoriahub-extensions');
    expect(restoreGateRegistry.list().map((gate) => gate.id)).toContain(MEMORIAHUB_EXTENSIONS_GATE_ID);
  });

  it('passes when the cluster offers vector', async () => {
    const outcome = await checkMemoriaHubExtensions(buildRestoreGateContext());
    expect(outcome.status).toBe('pass');
    expect(outcome.message).toContain('vector');
  });

  it('blocks (fail) with the remedy when vector is unavailable', async () => {
    state.offered = ['plpgsql'];
    const outcome = await checkMemoriaHubExtensions(buildRestoreGateContext());
    expect(outcome.status).toBe('fail');
    expect(outcome.message).toContain('vector');
    expect(outcome.action).toMatch(/pgvector/);
    expect(outcome.action).toMatch(/creates nothing itself/);
  });

  it('issues exactly one SELECT on pg_available_extensions and never a write', async () => {
    await checkMemoriaHubExtensions(buildRestoreGateContext());
    state.offered = [];
    await checkMemoriaHubExtensions(buildRestoreGateContext());

    expect(state.clients).toHaveLength(2);
    for (const client of state.clients) {
      expect(client.queries).toHaveLength(1);
      const [{ text, values }] = client.queries;
      expect(text).toMatch(/^\s*SELECT\b/i);
      expect(text).toMatch(/\bFROM\s+pg_available_extensions\b/i);
      expect(text).not.toMatch(WRITE_STATEMENT);
      expect(values).toEqual([['vector']]);
    }
  });

  it('connects with the pre-flight admin coordinates and closes the connection', async () => {
    const connection = { host: 'cluster.internal', port: '6543', user: 'admin_user', database: 'postgres', liveDatabase: 'app' };
    const base = buildRestoreGateContext();
    await checkMemoriaHubExtensions(buildRestoreGateContext({ facts: { ...base.facts, connection } }));
    expect(state.clients[0]).toMatchObject({ host: 'cluster.internal', port: 6543, user: 'admin_user', database: 'postgres' });
    expect(state.clients[0]!.ended).toBe(true);
  });

  it('closes the connection even when the query fails, and rejects (the pre-flight fails closed)', async () => {
    state.queryError = new Error('permission denied for view pg_available_extensions');
    await expect(checkMemoriaHubExtensions(buildRestoreGateContext())).rejects.toThrow(/permission denied/);
    expect(state.clients[0]!.ended).toBe(true);
  });

  it('rejects when the cluster cannot be reached', async () => {
    state.connectError = new Error('connect ECONNREFUSED');
    await expect(checkMemoriaHubExtensions(buildRestoreGateContext())).rejects.toThrow(/ECONNREFUSED/);
    expect(state.clients[0]!.queries).toEqual([]);
  });
});

describe('the Android releases restore carry-over', () => {
  it('is registered after the built-in carries', () => {
    expect(restoreCarryOverRegistry.list().map((carry) => carry.id)).toContain('mh_legacy_android_app_releases');
    expect(ANDROID_RELEASES_CARRY_OVER.order).toBeGreaterThan(0);
  });

  it('exports the losing current release before the new one (one current release at a time)', () => {
    expect(ANDROID_RELEASES_CARRY_OVER.exportSql).toMatch(/ORDER BY is_current, created_at, id/);
  });

  it('upserts by id from $1 and re-resolves the uploader', () => {
    const sql = ANDROID_RELEASES_CARRY_OVER.reinsertSql;
    expect(sql).toMatch(/jsonb_populate_record\(NULL::mh_legacy_android_app_releases, \$1::jsonb\)/);
    expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
    expect(sql).toMatch(/SELECT u\.id FROM users u WHERE u\.id = r\.uploaded_by_id/);
    expect(sql).toMatch(/is_current = EXCLUDED\.is_current/);
  });
});

describe('the legacy archive key prefix', () => {
  it('registers db-backups/ with deployment scope, surviving a factory reset', () => {
    expect(storageKeyPrefixRegistry.get(LEGACY_DB_BACKUP_KEY_PREFIX.id)).toMatchObject({
      prefix: 'db-backups/',
      scope: 'deployment',
      survivesFactoryReset: true,
    });
  });
});

// The platform's kit for any gate: valid definition, answers in time, writes nothing, repeatable.
describeRestoreGateConformance(
  { id: MEMORIAHUB_EXTENSIONS_GATE_ID, label: 'pgvector', check: (ctx) => checkMemoriaHubExtensions(ctx) },
  { describe, it, expect, scenarios: [{ name: 'vector offered', expectStatus: 'pass' }] },
);
