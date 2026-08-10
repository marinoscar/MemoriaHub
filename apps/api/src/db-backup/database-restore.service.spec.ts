/**
 * DatabaseRestoreService specs (issue #344, epic #339).
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE. There is no PostgreSQL here, so both
 * `pg_restore` and every cluster connection are mocked at their seams
 * (`__setSpawnForTests`, `__setAdminClientFactoryForTests`). What that leaves
 * testable is exactly the part worth testing at this level: the STATE MACHINE
 * — which gate produces which outcome, what is created, what is dropped, in
 * what ORDER the swap happens, and what is never touched on a failure. An
 * end-to-end restore is manual-acceptance territory (see the issue's checklist)
 * and is deliberately not attempted here.
 *
 * The recurring assertion style is an ORDERED EVENT LOG: the fake client pushes
 * every statement and the maintenance mock pushes its own marker into one
 * array, so "maintenance was entered BEFORE the rename" is a real ordering
 * assertion rather than two independent `toHaveBeenCalled`s that would pass
 * just as happily in the wrong order.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, statfs: jest.fn() };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsp = require('node:fs/promises') as { statfs: jest.Mock };

import {
  __setAdminClientFactoryForTests,
  type AdminClientLike,
} from './admin-connection.util';
import { __setSpawnForTests } from './pg-dump.util';
import { __resetPgVersionCacheForTests } from './pg-version.util';
import {
  DatabaseRestoreAlreadyRunningError,
  DatabaseRestoreNotAllowedError,
  DatabaseRestoreService,
} from './database-restore.service';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const LIVE_DB = 'memoriahub';

interface ClusterOptions {
  createdb: boolean;
  pgvector: boolean;
  dataDir: string | null;
  dbSizeBytes: string;
  distinctClients: string;
  connectThrows?: boolean;
  /** Fail the second rename, exercising the mid-swap recovery path. */
  failSecondRename?: boolean;
  /** Whether the retained pre-swap database still exists (rollback path). */
  oldDbExists?: boolean;
}

interface Harness {
  events: string[];
  queries: { db: string; text: string; values?: unknown[] }[];
  cluster: ClusterOptions;
}

function label(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('CREATE DATABASE')) return 'create-database';
  if (s.startsWith('DROP DATABASE')) return 'drop-database';
  if (s.startsWith('ALTER DATABASE')) return 'rename-database';
  if (s.includes('pg_terminate_backend')) return 'terminate';
  if (s.startsWith('INSERT INTO database_backup_runs')) return 'catalog-insert';
  if (s.startsWith('UPDATE database_backup_runs')) return 'catalog-update';
  return 'query';
}

function installFakeCluster(h: Harness): void {
  __setAdminClientFactoryForTests((cfg) => {
    const client: AdminClientLike = {
      async connect() {
        if (h.cluster.connectThrows) throw new Error('connection refused');
      },
      async end() {},
      async query(text: string, values?: unknown[]) {
        h.queries.push({ db: cfg.database, text, values });
        h.events.push(label(text));

        const s = text.replace(/\s+/g, ' ');

        if (s.includes('FROM pg_roles')) {
          return {
            rows: [
              { rolcreatedb: h.cluster.createdb, rolsuper: false } as any,
            ],
          };
        }
        if (s.includes('pg_available_extensions')) {
          return { rows: [{ ok: h.cluster.pgvector } as any] };
        }
        if (s.includes('pg_database_size')) {
          return { rows: [{ size: h.cluster.dbSizeBytes } as any] };
        }
        if (s.includes('SHOW data_directory')) {
          if (h.cluster.dataDir === null) throw new Error('permission denied');
          return { rows: [{ data_directory: h.cluster.dataDir } as any] };
        }
        if (s.includes('count(DISTINCT client_addr)')) {
          return { rows: [{ count: h.cluster.distinctClients } as any] };
        }
        if (s.includes('FROM pg_database')) {
          return { rows: [{ ok: h.cluster.oldDbExists !== false } as any] };
        }
        if (s.includes('pg_terminate_backend')) return { rows: [] };
        if (s.startsWith('ALTER DATABASE')) {
          const isSecond =
            h.events.filter((e) => e === 'rename-database').length === 2;
          if (h.cluster.failSecondRename && isSecond) {
            throw new Error('rename failed');
          }
          return { rows: [] };
        }
        if (s.includes("extname = 'vector'")) return { rows: [{ ok: true } as any] };
        if (s.includes('information_schema.tables')) {
          return {
            rows: (values?.[0] as string[]).map((t) => ({ table_name: t }) as any),
          };
        }
        if (s.includes('FROM users')) return { rows: [{ count: '7' } as any] };
        if (s.includes('pg_index')) return { rows: [{ count: '0' } as any] };
        return { rows: [] };
      },
    };
    return client;
  });
}

/** ChildProcess stand-in, matching `pg-dump.util.spec.ts`'s helper. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: jest.Mock;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = jest.fn();
  return child;
}

/** `pg_restore --list` must produce a TOC; `pg_restore` exit code is settable. */
function installFakeSpawn(opts: { restoreExitCode?: number } = {}): jest.Mock {
  const spawn = jest.fn((_cmd: string, args: readonly string[]) => {
    const child = makeFakeChild();
    const isList = args.includes('--list');
    setImmediate(() => {
      if (isList) {
        child.stdout.write(';  1234; TABLE media_items\n');
        child.emit('close', 0, null);
      } else {
        child.emit('close', opts.restoreExitCode ?? 0, null);
      }
    });
    return child as any;
  });
  __setSpawnForTests(spawn as any);
  return spawn;
}

/**
 * Installs a fake low-level spawn that answers ONLY `<binary> --version`
 * probes (issue #364's `readPgClientMajor`, used by `checkPgClientVersion`)
 * with the given stdout text and exit code. `preflight()` never invokes
 * `pg_restore --list` or a full restore — those happen later, in the async
 * execute phase — so during a preflight-only test this is the only spawn that
 * can occur; no need to also special-case `--list` the way `installFakeSpawn`
 * above does.
 */
function installClientVersionSpawn(output: string, exitCode = 0): void {
  __setSpawnForTests((() => {
    const child = makeFakeChild();
    setImmediate(() => {
      if (output) child.stdout.write(output);
      child.emit('close', exitCode, null);
    });
    return child;
  }) as never);
}

/** Routes a harness's `prisma.$queryRaw` server_version_num probe to a
 * specific value while preserving the `_prisma_migrations` handling `build()`
 * already wires up (so schema compatibility keeps working normally). */
function mockServerVersionNum(
  prisma: { $queryRaw: jest.Mock },
  num: number | null,
  liveMigration = 'm_current',
): void {
  prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
    if (sql.includes('server_version_num')) {
      return Promise.resolve(num === null ? [] : [{ num }]);
    }
    if (sql.includes('_prisma_migrations')) {
      return Promise.resolve([{ migration_name: liveMigration }]);
    }
    return Promise.resolve([]);
  });
}

const COMPLETED_RUN = {
  id: 'run-1',
  status: 'completed',
  storageProvider: 's3',
  storageKey: 'db-backups/x.dump',
  bucket: 'bkt',
  checksumSha256: null,
  sizeBytes: 1000n,
  bytesWritten: 1000n,
  migrationName: 'm_current',
  restoreStatus: null,
  restoreOldDb: null,
  preRestoreBackupId: null,
  startedAt: new Date('2026-08-01T00:00:00Z'),
};

function build(overrides: {
  cluster?: Partial<ClusterOptions>;
  run?: Record<string, unknown>;
  rollbackMode?: 'retain_database' | 'pre_restore_dump';
  liveMigration?: string;
  activeRestoreId?: string | null;
  catalogRows?: Record<string, unknown>[];
} = {}) {
  const h: Harness = {
    events: [],
    queries: [],
    cluster: {
      createdb: true,
      pgvector: true,
      dataDir: '/var/lib/postgresql/data',
      dbSizeBytes: '1000',
      distinctClients: '1',
      ...(overrides.cluster ?? {}),
    },
  };
  installFakeCluster(h);

  const run = { ...COMPLETED_RUN, ...(overrides.run ?? {}) };

  const prisma = {
    databaseBackupRun: {
      findUnique: jest.fn().mockResolvedValue(run),
      findUniqueOrThrow: jest.fn().mockResolvedValue(run),
      findMany: jest
        .fn()
        .mockResolvedValue(overrides.catalogRows ?? [run as any]),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          overrides.activeRestoreId ? { id: overrides.activeRestoreId } : null,
        ),
      update: jest.fn().mockResolvedValue(run),
    },
    $queryRaw: jest
      .fn()
      .mockResolvedValue([
        { migration_name: overrides.liveMigration ?? 'm_current' },
      ]),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };

  const config = {
    get: jest.fn((key: string) =>
      ({
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: '5432',
        POSTGRES_USER: 'appuser',
        POSTGRES_PASSWORD: 'pw',
        POSTGRES_DB: LIVE_DB,
      })[key],
    ),
  };

  const systemSettings = {
    getSettings: jest.fn().mockResolvedValue({
      databaseBackup: {
        restoreRollbackMode: overrides.rollbackMode ?? 'retain_database',
      },
    }),
  };

  const providerResolver = {
    getProviderFor: jest.fn().mockResolvedValue({
      download: jest.fn().mockResolvedValue(Readable.from([Buffer.from('dump')])),
    }),
  };

  const maintenance = {
    enable: jest.fn(async (...args: unknown[]) => {
      h.events.push(`maintenance:${JSON.stringify(args[2] ?? {})}`);
      return {} as any;
    }),
    setState: jest.fn(),
    disable: jest.fn(),
  };

  const backupRunner = {
    runBackup: jest.fn().mockResolvedValue({ runId: 'safety-1' }),
  };

  const exit = jest.fn();

  const service = new DatabaseRestoreService(
    prisma as any,
    config as any,
    systemSettings as any,
    providerResolver as any,
    maintenance as any,
    backupRunner as any,
  );
  service.__setExitHookForTests(exit);

  // `startRestore` DETACHES the multi-hour restore deliberately (it must
  // outlive the HTTP request), which in a test means a pre-flight case would
  // leave a real restore running into the NEXT test — and, because the fake
  // cluster factory is process-global, spraying its statements into that
  // test's event log. So the instance method is stubbed by default and the
  // real one handed back for the tests that actually exercise it.
  const realExecute = (service as any).executeRestore.bind(service);
  const executeSpy = jest.fn().mockResolvedValue(undefined);
  (service as any).executeRestore = executeSpy;

  return {
    service,
    prisma,
    maintenance,
    backupRunner,
    exit,
    h,
    providerResolver,
    realExecute,
    executeSpy,
  };
}

const CTX = {
  pg: {
    host: 'db',
    port: 5432,
    user: 'appuser',
    password: 'pw',
    database: LIVE_DB,
  },
  scratchDatabase: `${LIVE_DB}_restore_20260810000000`,
  oldDatabase: `${LIVE_DB}_old_20260810000000`,
  userId: 'admin-1',
};

beforeEach(() => {
  installFakeSpawn();
  fsp.statfs.mockResolvedValue({ bavail: 1_000_000, bsize: 4096 });
});

afterEach(() => {
  __setAdminClientFactoryForTests(null);
  __setSpawnForTests(null);
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Pre-flight outcomes
// ---------------------------------------------------------------------------

describe('pre-flight gates', () => {
  it('falls back to GUIDED restore when the role lacks CREATEDB', async () => {
    const { service, h, prisma } = build({ cluster: { createdb: false } });

    const result = await service.startRestore('run-1', { userId: 'admin-1' });

    expect(result.mode).toBe('guided');
    if (result.mode !== 'guided') throw new Error('unreachable');
    expect(result.guided.commands.join('\n')).toContain('createdb');
    expect(result.guided.runbook).toContain('database-restore.md');
    // A capability failure must not create anything.
    expect(h.events).not.toContain('create-database');
    expect(prisma.databaseBackupRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ restoreStatus: 'guided' }),
      }),
    );
  });

  it('falls back to GUIDED restore when pgvector is unavailable', async () => {
    const { service } = build({ cluster: { pgvector: false } });
    const result = await service.startRestore('run-1', { userId: 'admin-1' });
    expect(result.mode).toBe('guided');
  });

  it('falls back to GUIDED restore when the cluster admin connection fails', async () => {
    const { service } = build({ cluster: { connectThrows: true } });
    const result = await service.startRestore('run-1', { userId: 'admin-1' });
    expect(result.mode).toBe('guided');
    if (result.mode !== 'guided') throw new Error('unreachable');
    expect(result.preflight.checks.map((c) => c.key)).toContain(
      'capability.admin_connection',
    );
  });

  it('never leaks the database password into the guided command block', async () => {
    const { service } = build({ cluster: { createdb: false } });
    const result = await service.startRestore('run-1', { userId: 'admin-1' });
    if (result.mode !== 'guided') throw new Error('unreachable');
    expect(result.guided.commands.join('\n')).not.toContain('pw');
  });

  it('BLOCKS a schema mismatch by default and proceeds with the override', async () => {
    const blocked = build({
      run: { migrationName: 'm_old' },
      liveMigration: 'm_current',
    });
    const first = await blocked.service.startRestore('run-1', {
      userId: 'admin-1',
    });
    expect(first.mode).toBe('blocked');
    if (first.mode !== 'blocked') throw new Error('unreachable');
    expect(first.reason).toContain('m_old');

    const overridden = build({
      run: { migrationName: 'm_old' },
      liveMigration: 'm_current',
    });
    const second = await overridden.service.startRestore('run-1', {
      userId: 'admin-1',
      overrideSchemaCheck: true,
    });
    expect(second.mode).toBe('running');
    expect(overridden.executeSpy).toHaveBeenCalled();
  });

  it('DOWNGRADES retain_database to pre_restore_dump when disk is short, and reports it', async () => {
    // 4 KB free against a 100 GB database: nowhere near enough for a scratch
    // copy plus the retained pre-swap database.
    fsp.statfs.mockResolvedValue({ bavail: 1, bsize: 4096 });
    const { service } = build({
      cluster: { dbSizeBytes: String(100 * 1024 ** 3) },
      rollbackMode: 'retain_database',
    });

    const result = await service.startRestore('run-1', { userId: 'admin-1' });

    expect(result.mode).toBe('running');
    if (result.mode !== 'running') throw new Error('unreachable');
    // Degrade, never refuse — the admin must always have a path forward.
    expect(result.rollbackMode).toBe('pre_restore_dump');
    expect(result.rollbackModeDowngraded).toBe(true);
    expect(result.preflight.downgradeReason).toMatch(/downgraded/i);
    expect(result.preflight.checks.map((c) => c.key)).toContain(
      'rollback.downgraded',
    );
  });

  it('warns instead of blocking when free space cannot be measured', async () => {
    const { service } = build({ cluster: { dataDir: null } });
    const result = await service.startRestore('run-1', { userId: 'admin-1' });
    expect(result.mode).toBe('running');
    const disk = result.preflight.checks.find((c) => c.key === 'disk.free');
    expect(disk?.status).toBe('warning');
  });

  it('warns when more than one client address is connected (multi-replica)', async () => {
    const { service } = build({ cluster: { distinctClients: '3' } });
    const result = await service.startRestore('run-1', { userId: 'admin-1' });
    const replicas = result.preflight.checks.find(
      (c) => c.key === 'replicas.single',
    );
    expect(replicas?.status).toBe('warning');
    expect(replicas?.message).toMatch(/SINGLE API replica/);
  });

  it('refuses a run that is not completed, and one with no storage location', async () => {
    const notCompleted = build({ run: { status: 'failed' } });
    await expect(
      notCompleted.service.startRestore('run-1', { userId: 'admin-1' }),
    ).rejects.toBeInstanceOf(DatabaseRestoreNotAllowedError);

    const noKey = build({ run: { storageKey: null } });
    await expect(
      noKey.service.startRestore('run-1', { userId: 'admin-1' }),
    ).rejects.toBeInstanceOf(DatabaseRestoreNotAllowedError);
  });

  it('refuses to start a second concurrent restore', async () => {
    const { service } = build({ activeRestoreId: 'run-other' });
    await expect(
      service.startRestore('run-1', { userId: 'admin-1' }),
    ).rejects.toBeInstanceOf(DatabaseRestoreAlreadyRunningError);
  });
});

// ---------------------------------------------------------------------------
// The restore + swap
// ---------------------------------------------------------------------------

describe('restore execution and swap', () => {
  async function execute(
    harness: ReturnType<typeof build>,
    rollbackMode: 'retain_database' | 'pre_restore_dump' = 'retain_database',
  ) {
    return harness.realExecute('run-1', { ...CTX, rollbackMode });
  }

  it('creates the scratch database, restores into it, and swaps in order', async () => {
    const harness = build();
    await execute(harness);

    const { events } = harness.h;
    expect(events).toContain('create-database');

    const maintenanceAt = events.findIndex((e) => e.startsWith('maintenance:'));
    const terminateAt = events.indexOf('terminate');
    const firstRenameAt = events.indexOf('rename-database');

    // Maintenance mode must be in force BEFORE anything is renamed.
    expect(maintenanceAt).toBeGreaterThanOrEqual(0);
    expect(maintenanceAt).toBeLessThan(terminateAt);
    expect(terminateAt).toBeLessThan(firstRenameAt);

    const renames = harness.h.queries.filter((q) =>
      q.text.startsWith('ALTER DATABASE'),
    );
    expect(renames).toHaveLength(2);
    // live -> old, then scratch -> live.
    expect(renames[0].text).toContain(`"${LIVE_DB}" RENAME TO`);
    expect(renames[0].text).toContain(CTX.oldDatabase);
    expect(renames[1].text).toContain(CTX.scratchDatabase);
    expect(renames[1].text).toContain(`RENAME TO "${LIVE_DB}"`);
  });

  it('uses the IN-MEMORY maintenance layer with admins blocked, never the persisted setting', async () => {
    const harness = build();
    await execute(harness);

    expect(harness.maintenance.enable).toHaveBeenCalledWith(
      expect.any(String),
      'admin-1',
      { allowAdmins: false },
    );
    // The persisted flag lives inside the database being renamed; writing it
    // here would be a write to a database that is about to disappear.
    expect(harness.maintenance.setState).not.toHaveBeenCalled();
  });

  it('exits the process after a successful swap so the pool is rebuilt', async () => {
    const harness = build();
    await execute(harness);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('runs pg_restore in PARALLEL against the scratch database, never the live one', async () => {
    const harness = build();
    const spawn = installFakeSpawn();
    await execute(harness);

    const restoreCall = spawn.mock.calls.find(
      (c) => !(c[1] as string[]).includes('--list'),
    );
    const args = restoreCall![1] as string[];
    expect(args).toContain('-j');
    expect(args).toContain('--no-owner');
    expect(args).toContain(CTX.scratchDatabase);
    expect(args).not.toContain(LIVE_DB);
    // `--clean` is the design epic #339 rejected; it must never appear.
    expect(args).not.toContain('--clean');
  });

  it('carries the backup catalog across the swap', async () => {
    const harness = build({
      catalogRows: [
        { ...COMPLETED_RUN },
        { ...COMPLETED_RUN, id: 'run-2', preRestoreBackupId: 'run-1' },
      ],
    });
    await execute(harness);

    const inserts = harness.h.queries.filter((q) =>
      q.text.startsWith('INSERT INTO database_backup_runs'),
    );
    expect(inserts).toHaveLength(2);
    // Re-inserted into the NEWLY-renamed live database, not the scratch name.
    expect(inserts.every((i) => i.db === LIVE_DB)).toBe(true);
    // This restore's own row carries its completed audit fields across.
    expect(inserts[0].values).toContain('completed');
    // The self-FK is applied in a second pass, once every row exists.
    expect(
      harness.h.queries.some((q) =>
        q.text.includes('SET pre_restore_backup_id'),
      ),
    ).toBe(true);
  });

  it('retains the pre-swap database in retain_database mode', async () => {
    const harness = build();
    await execute(harness, 'retain_database');
    expect(harness.h.events).not.toContain('drop-database');
  });

  it('drops the pre-swap database (and takes a safety dump) in pre_restore_dump mode', async () => {
    const harness = build({ rollbackMode: 'pre_restore_dump' });
    await execute(harness, 'pre_restore_dump');

    expect(harness.backupRunner.runBackup).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'pre_restore' }),
    );
    const drops = harness.h.queries.filter((q) =>
      q.text.startsWith('DROP DATABASE'),
    );
    expect(drops.some((d) => d.text.includes(CTX.oldDatabase))).toBe(true);
  });

  it('puts the original database back if the second rename fails', async () => {
    const harness = build({ cluster: { failSecondRename: true } });
    await expect(execute(harness)).rejects.toThrow();

    const renames = harness.h.queries.filter((q) =>
      q.text.startsWith('ALTER DATABASE'),
    );
    // live->old, the failed scratch->live, then the recovery old->live.
    expect(renames).toHaveLength(3);
    expect(renames[2].text).toContain(`"${CTX.oldDatabase}" RENAME TO`);
    expect(renames[2].text).toContain(`"${LIVE_DB}"`);
  });
});

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

describe('mid-restore failure', () => {
  it('leaves the live database untouched and DROPS the scratch database', async () => {
    installFakeSpawn({ restoreExitCode: 1 });
    const harness = build();

    await expect(
      harness.realExecute('run-1', { ...CTX, rollbackMode: 'retain_database' }),
    ).rejects.toThrow();

    // Nothing renamed, nothing terminated, no maintenance window: the live
    // database never knew a restore was happening.
    expect(harness.h.events).not.toContain('rename-database');
    expect(harness.h.events).not.toContain('terminate');
    expect(harness.maintenance.enable).not.toHaveBeenCalled();

    // And no several-hundred-GB scratch database left behind.
    const drops = harness.h.queries.filter((q) =>
      q.text.startsWith('DROP DATABASE'),
    );
    expect(drops.some((d) => d.text.includes(CTX.scratchDatabase))).toBe(true);

    expect(harness.prisma.databaseBackupRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ restoreStatus: 'failed' }),
      }),
    );
  });

  it('fails before creating anything when the artifact checksum does not match', async () => {
    const harness = build({ run: { checksumSha256: 'deadbeef' } });

    await expect(
      harness.realExecute('run-1', { ...CTX, rollbackMode: 'retain_database' }),
    ).rejects.toThrow(/checksum mismatch/i);

    expect(harness.h.events).not.toContain('create-database');
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe('rollback', () => {
  it('renames the retained database back and exits (retain_database)', async () => {
    const harness = build({
      run: {
        restoreStatus: 'completed',
        restoreOldDb: `${LIVE_DB}_old_20260810000000`,
      },
    });

    const result = await harness.service.rollback('run-1', {
      userId: 'admin-1',
    });

    expect(result.mode).toBe('renamed');
    const renames = harness.h.queries.filter((q) =>
      q.text.startsWith('ALTER DATABASE'),
    );
    expect(renames).toHaveLength(2);
    expect(renames[0].text).toContain(`"${LIVE_DB}" RENAME TO`);
    expect(renames[1].text).toContain(
      `"${LIVE_DB}_old_20260810000000" RENAME TO "${LIVE_DB}"`,
    );
    expect(harness.maintenance.enable).toHaveBeenCalledWith(
      expect.any(String),
      'admin-1',
      { allowAdmins: false },
    );
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('starts a full restore of the pre-restore dump when no database was retained', async () => {
    const harness = build({
      run: {
        restoreStatus: 'completed',
        restoreOldDb: null,
        preRestoreBackupId: 'safety-1',
      },
    });
    const spy = jest
      .spyOn(harness.service, 'startRestore')
      .mockResolvedValue({ mode: 'running' } as any);

    const result = await harness.service.rollback('run-1', {
      userId: 'admin-1',
    });

    expect(result.mode).toBe('restore_started');
    expect(spy).toHaveBeenCalledWith('safety-1', {
      userId: 'admin-1',
      overrideSchemaCheck: true,
    });
  });

  it('refuses when the retained database has already been reaped', async () => {
    const harness = build({
      cluster: { oldDbExists: false },
      run: {
        restoreStatus: 'completed',
        restoreOldDb: `${LIVE_DB}_old_20260810000000`,
      },
    });
    await expect(
      harness.service.rollback('run-1', { userId: 'admin-1' }),
    ).rejects.toBeInstanceOf(DatabaseRestoreNotAllowedError);
  });

  it('reports `unavailable` when neither a retained database nor a dump exists', async () => {
    const harness = build({
      run: { restoreStatus: 'completed', restoreOldDb: null },
    });
    const result = await harness.service.rollback('run-1', {
      userId: 'admin-1',
    });
    expect(result.mode).toBe('unavailable');
  });

  it('refuses to roll back a run with no completed restore', async () => {
    const harness = build({ run: { restoreStatus: null } });
    await expect(
      harness.service.rollback('run-1', { userId: 'admin-1' }),
    ).rejects.toBeInstanceOf(DatabaseRestoreNotAllowedError);
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL client/server version guard (issue #364)
// ---------------------------------------------------------------------------

describe('pg client/server version guard (issue #364)', () => {
  beforeEach(() => {
    // The memo is keyed by resolved binary path and lives for the whole
    // file (module state is not reset between tests) — without this, a
    // prior test's probe (real or faked) would answer this one too.
    __resetPgVersionCacheForTests();
  });

  afterEach(() => {
    __resetPgVersionCacheForTests();
  });

  it('a client OLDER than the server BLOCKS capability.pg_client_version, forcing guided mode', async () => {
    installClientVersionSpawn('pg_dump (PostgreSQL) 16.4');
    const { service, prisma } = build();
    mockServerVersionNum(prisma, 170010); // server major 17

    const result = await service.startRestore('run-1', { userId: 'admin-1' });

    expect(result.mode).toBe('guided');
    if (result.mode !== 'guided') throw new Error('unreachable');
    const check = result.preflight.checks.find(
      (c) => c.key === 'capability.pg_client_version',
    );
    expect(check?.status).toBe('blocked');
    expect(check?.message).toContain('16.x');
    expect(check?.message).toContain('17.x');
  });

  it('an UNKNOWN verdict (client unreadable) WARNS but does NOT force guided mode', async () => {
    installClientVersionSpawn('', 1); // non-zero exit -> unparseable/null client major
    const { service, prisma } = build();
    mockServerVersionNum(prisma, 170010);

    const result = await service.startRestore('run-1', { userId: 'admin-1' });

    expect(result.mode).toBe('running');
    if (result.mode !== 'running') throw new Error('unreachable');
    const check = result.preflight.checks.find(
      (c) => c.key === 'capability.pg_client_version',
    );
    expect(check?.status).toBe('warning');
  });

  it('client >= server is status: ok', async () => {
    installClientVersionSpawn('pg_restore (PostgreSQL) 17.4');
    const { service, prisma } = build();
    mockServerVersionNum(prisma, 170010);

    const result = await service.startRestore('run-1', { userId: 'admin-1' });

    expect(result.mode).toBe('running');
    if (result.mode !== 'running') throw new Error('unreachable');
    const check = result.preflight.checks.find(
      (c) => c.key === 'capability.pg_client_version',
    );
    expect(check?.status).toBe('ok');
  });

  it('is present EXACTLY ONCE even when the cluster admin connection throws — it runs OUTSIDE withAdminConnection, so a connection failure can neither swallow nor duplicate it', async () => {
    installClientVersionSpawn('pg_dump (PostgreSQL) 17.4');
    const { service, prisma } = build({ cluster: { connectThrows: true } });
    mockServerVersionNum(prisma, 170010);

    const result = await service.startRestore('run-1', { userId: 'admin-1' });

    // The admin-connection failure alone already forces guided mode; this
    // test's point is the COUNT of the version check, not the outer mode.
    expect(result.mode).toBe('guided');
    if (result.mode !== 'guided') throw new Error('unreachable');
    const matches = result.preflight.checks.filter(
      (c) => c.key === 'capability.pg_client_version',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].status).toBe('ok');
  });
});
