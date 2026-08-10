/**
 * `pg_restore` process wrapper (issue #344, epic #339).
 *
 * The restore counterpart to `pg-dump.util.ts`. It deliberately reuses that
 * module's {@link spawnPgProcess} runner rather than re-implementing the child
 * handling: the SIGKILL-guarded timeout, the `settled` double-settle guard, the
 * BOUNDED stderr tail, and — the security-critical one — passing the database
 * password through `PGPASSWORD` in the child ENVIRONMENT and never in argv, are
 * exactly the details a second copy would eventually get subtly wrong.
 *
 * TWO THINGS ARE DIFFERENT FROM THE DUMP SIDE, and both shape this module:
 *
 * 1. **A parallel restore needs a FILE, not a pipe.** `pg_restore -j N` runs N
 *    workers that each seek independently within the archive, which stdin
 *    cannot support — pass `-j` with an archive on stdin and pg_restore refuses.
 *    Parallelism is not optional here: epic #339 sizes the restore as dominated
 *    by rebuilding HNSW indexes over ~1M vectors, and index builds are precisely
 *    what `-j` parallelises. So the orchestration downloads the artifact to a
 *    temp file first and this module always takes a path.
 *
 * 2. **Nothing is streamed back.** `pg_restore` writes to the SERVER, not to
 *    stdout, so unlike `spawnPgDump` there is no multi-GB stream for the caller
 *    to consume — only the exit status and the stderr tail matter.
 */

import * as os from 'node:os';

import {
  buildPgEnv,
  resolvePgRestorePath,
  spawnPgProcess,
  type PgConnectionConfig,
  type SpawnPgOptions,
  type SpawnedPgProcess,
} from './pg-dump.util';

// ---------------------------------------------------------------------------
// Parallelism
// ---------------------------------------------------------------------------

/**
 * Upper bound on `pg_restore -j`.
 *
 * Each job is a separate server connection running a CPU- and memory-hungry
 * index build. Postgres' own `max_connections` (100 by default) and the
 * maintenance-work-mem budget per build are the real constraints, not the core
 * count of the API container — a 64-core host would otherwise open 64 parallel
 * HNSW builds and thrash. 8 is the point past which restore throughput on this
 * workload is bounded by disk and shared buffers rather than by cores.
 */
export const MAX_PG_RESTORE_JOBS = 8;

/**
 * Resolve `-j`: `os.cpus().length`, clamped to [1, {@link MAX_PG_RESTORE_JOBS}],
 * with an explicit `PG_RESTORE_JOBS` env override for operators who know their
 * database host better than this heuristic does.
 *
 * NOTE the asymmetry this heuristic quietly assumes: `os.cpus()` reports the
 * cores of the machine running the API, while the index rebuild burns cores on
 * the DATABASE host. They are the same machine in the single-host compose
 * deployment this feature targets, and diverge on managed Postgres — which is
 * exactly why the env override exists.
 */
export function resolveParallelJobs(
  cpuCount: number = safeCpuCount(),
  envValue: string | undefined = process.env.PG_RESTORE_JOBS,
): number {
  const override = Number(envValue);
  if (Number.isFinite(override) && override >= 1) {
    return Math.min(Math.floor(override), MAX_PG_RESTORE_JOBS);
  }
  if (!Number.isFinite(cpuCount) || cpuCount < 1) return 1;
  return Math.min(Math.max(1, Math.floor(cpuCount)), MAX_PG_RESTORE_JOBS);
}

function safeCpuCount(): number {
  try {
    return os.cpus()?.length ?? 1;
  } catch {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export interface PgRestoreArgsOptions {
  /** Target database — ALWAYS the scratch database, never the live one. */
  database: string;
  /** Local path of the downloaded archive. */
  filePath: string;
  jobs: number;
  /** See {@link resolveExitOnError}. */
  exitOnError?: boolean;
}

/**
 * Build the argv for a parallel restore into the scratch database.
 *
 * `-d <scratch>`     the target. Note the value comes from the orchestrator's
 *                    generated scratch name, never from user input.
 * `-j N`             parallel workers; the whole point (see module header).
 * `--no-owner`       the archive was dumped `--no-owner`; ownership is taken by
 *                    the restoring role. Restated here so a hand-made archive
 *                    with owners baked in still restores.
 * `--no-acl`         same reasoning for GRANTs.
 * `--exit-on-error`  fail LOUDLY. Without it `pg_restore` logs errors, keeps
 *                    going, and exits 0 — producing a half-populated database
 *                    that would then be swapped in as if it were good. Because
 *                    the live database is untouched until the swap, failing
 *                    here costs only the scratch database.
 *
 * Deliberately NO `--clean`/`--if-exists`: this restores into a database that
 * was just created empty. `--clean` against the LIVE database is the design
 * epic #339 rejected outright — see the module header of
 * `database-restore.service.ts`.
 */
export function buildPgRestoreArgs(
  cfg: PgConnectionConfig,
  opts: PgRestoreArgsOptions,
): string[] {
  const args = [
    '-d',
    opts.database,
    '-j',
    String(opts.jobs),
    '--no-owner',
    '--no-acl',
  ];
  if (opts.exitOnError !== false) args.push('--exit-on-error');
  args.push(
    '-h',
    cfg.host,
    '-p',
    String(cfg.port),
    '-U',
    cfg.user,
    opts.filePath,
  );
  return args;
}

/** `pg_restore --list <file>` — TOC read of a LOCAL archive; touches no server. */
export function buildPgRestoreListFileArgs(filePath: string): string[] {
  return ['--list', filePath];
}

/**
 * `--exit-on-error` is on unless an operator explicitly turns it off with
 * `PG_RESTORE_EXIT_ON_ERROR=false`.
 *
 * The escape hatch exists because a small number of archive entries can fail
 * benignly against a differently-privileged role (the classic being
 * `COMMENT ON EXTENSION`), and an admin staring at a real outage must be able
 * to say "I have read the errors, proceed". It is off-by-default-dangerous, so
 * it is opt-in and logged by the caller.
 */
export function resolveExitOnError(
  envValue: string | undefined = process.env.PG_RESTORE_EXIT_ON_ERROR,
): boolean {
  return String(envValue ?? '').trim().toLowerCase() !== 'false';
}

// ---------------------------------------------------------------------------
// Spawners
// ---------------------------------------------------------------------------

/**
 * Spawn a parallel `pg_restore` into `opts.database` from a local archive file.
 *
 * The returned `done` promise is the whole contract: it resolves only on a
 * clean exit and otherwise rejects carrying the bounded stderr tail. `stdout`
 * exists but carries only progress chatter; the caller should not depend on it.
 */
export function spawnPgRestore(
  cfg: PgConnectionConfig,
  opts: PgRestoreArgsOptions,
  spawnOpts: SpawnPgOptions = {},
): SpawnedPgProcess {
  return spawnPgProcess(
    resolvePgRestorePath(),
    buildPgRestoreArgs(cfg, opts),
    buildPgEnv(cfg),
    spawnOpts,
    'pg_restore',
  );
}

/**
 * Spawn `pg_restore --list <file>` — the pre-flight artifact check.
 *
 * The dump engine (#341) already verifies the archive by streaming the UPLOADED
 * object through `--list` at backup time. This re-runs it on the bytes actually
 * downloaded for THIS restore, because the failure being guarded against is
 * different: bit-rot or a truncated download in the interval since, which the
 * backup-time check by definition cannot have seen.
 */
export function spawnPgRestoreListFile(
  cfg: PgConnectionConfig,
  filePath: string,
  spawnOpts: SpawnPgOptions = {},
): SpawnedPgProcess {
  return spawnPgProcess(
    resolvePgRestorePath(),
    buildPgRestoreListFileArgs(filePath),
    buildPgEnv(cfg),
    spawnOpts,
    'pg_restore --list',
  );
}
