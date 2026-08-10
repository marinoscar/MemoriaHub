/**
 * pg_dump / pg_restore process wrapper (issue #341, epic #339).
 *
 * A deliberately thin `spawn` wrapper shaped for the ONE thing the database
 * backup engine needs and that `packages/enrichment-compute/src/ffmpeg`'s
 * runner cannot give it: the child's stdout as a live {@link Readable} rather
 * than a collected string. A `pg_dump` of this database is multi-GB (see epic
 * #339's sizing), so its stdout must be piped straight into object storage
 * with backpressure — buffering it into a string, a Buffer, or a chunk array
 * would reintroduce exactly the multi-GB memory use this design exists to
 * avoid.
 *
 * Everything else mirrors the ffmpeg runner's proven handling:
 *   - hard timeout enforced with SIGKILL (a dump can wedge on a stuck socket
 *     and SIGTERM is not guaranteed to land),
 *   - a `settled` guard so the post-SIGKILL 'close'/'error' events are
 *     harmless no-ops rather than a second settle,
 *   - BOUNDED stderr capture (tail only) — `pg_dump` can emit an unbounded
 *     stream of per-object warnings, and only the tail is useful as
 *     `DatabaseBackupRun.lastError`.
 *
 * SECURITY — the database password is passed through the child's ENVIRONMENT
 * as `PGPASSWORD` and NEVER as an argv element. Process argv is world-readable
 * via `ps`/`/proc/<pid>/cmdline` to every other user on the host, so a
 * `--password=…` style flag would leak the database credential to any local
 * process. This is a security requirement, not a style preference; the
 * corresponding assertion lives in `pg-dump.util.spec.ts`.
 */

import { spawn as childProcessSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Spawn seam (test-only)
// ---------------------------------------------------------------------------

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

let spawnImpl: SpawnLike = childProcessSpawn as unknown as SpawnLike;

/**
 * TEST-ONLY seam: swap the `child_process.spawn` implementation used by
 * {@link spawnPgDump} / {@link spawnPgRestoreList}. Pass `null` to restore the
 * real `spawn`. Production code must never call this.
 *
 * Mirrors `packages/enrichment-compute/src/ffmpeg`'s `__setSpawnForTests`: an
 * explicit, documented seam beats module-level mocking of a Node builtin.
 */
export function __setSpawnForTests(impl: SpawnLike | null): void {
  spawnImpl = impl ?? (childProcessSpawn as unknown as SpawnLike);
}

// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------

/** Resolve `pg_dump`, honouring `PG_DUMP_PATH` and otherwise using PATH. */
export function resolvePgDumpPath(): string {
  const configured = process.env.PG_DUMP_PATH;
  return configured && configured.trim() ? configured : 'pg_dump';
}

/** Resolve `pg_restore`, honouring `PG_RESTORE_PATH` and otherwise using PATH. */
export function resolvePgRestorePath(): string {
  const configured = process.env.PG_RESTORE_PATH;
  return configured && configured.trim() ? configured : 'pg_restore';
}

// ---------------------------------------------------------------------------
// Connection + argv
// ---------------------------------------------------------------------------

export interface PgConnectionConfig {
  host: string;
  port: number;
  user: string;
  /** NEVER placed in argv — see this module's security note. */
  password: string;
  database: string;
}

/**
 * Build the argv for a custom-format dump written to stdout.
 *
 * `-Fc`          custom archive format — the only format `pg_restore` can
 *                reorder/parallelise, and a single file (unlike `-Fd`).
 * `--no-owner`   ownership is re-established by the restore target's role, so
 *                baking the source owner in makes a cross-host restore fail.
 * `--no-acl`     same reasoning for GRANTs.
 * `-Z <level>`   compression. Defaults low (see `databaseBackup.compressionLevel`)
 *                because float embedding vectors dominate the dump and are
 *                near-incompressible — a high level burns CPU for little gain.
 *
 * No `-f`: `pg_dump` writes the archive to stdout when no output file is given,
 * which is what lets it be piped straight to storage.
 */
export function buildPgDumpArgs(
  cfg: PgConnectionConfig,
  compressionLevel: number,
): string[] {
  return [
    '-Fc',
    '--no-owner',
    '--no-acl',
    '-Z',
    String(compressionLevel),
    '-h',
    cfg.host,
    '-p',
    String(cfg.port),
    '-U',
    cfg.user,
    '-d',
    cfg.database,
  ];
}

/**
 * Build the argv for `pg_restore --list` reading the archive from STDIN.
 *
 * With no filename operand `pg_restore` reads standard input, so the uploaded
 * object can be streamed straight back through it. Listing the archive's table
 * of contents requires parsing the archive header and TOC, which a truncated
 * or corrupt upload cannot satisfy — that is the whole point of the check.
 */
export function buildPgRestoreListArgs(): string[] {
  return ['--list'];
}

/**
 * Build the child environment: the parent env plus `PGPASSWORD`.
 *
 * Exported so the spec can assert the password is here and NOT in argv.
 */
export function buildPgEnv(
  cfg: PgConnectionConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...baseEnv, PGPASSWORD: cfg.password };
}

// ---------------------------------------------------------------------------
// Bounded stderr capture
// ---------------------------------------------------------------------------

/** Characters of stderr retained. Only the TAIL is kept — see module header. */
export const STDERR_TAIL_MAX_CHARS = 4000;

function makeTailBuffer(maxChars: number) {
  let buf = '';
  return {
    append(chunk: string): void {
      buf += chunk;
      if (buf.length > maxChars) buf = buf.slice(buf.length - maxChars);
    },
    get(): string {
      return buf.trim();
    },
  };
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

export interface SpawnPgOptions {
  /**
   * Hard timeout in ms. The child is SIGKILLed and `done` rejects. `0`,
   * `undefined`, or a non-finite value disables the timeout.
   */
  timeoutMs?: number;
}

export interface SpawnedPgProcess {
  /**
   * The child's stdout, as a live stream. For `pg_dump` this is the archive
   * itself — pipe it, never collect it.
   */
  stdout: Readable;
  /** The child's stdin, present only for processes spawned to read input. */
  stdin: Writable | null;
  /**
   * Resolves once the process exits cleanly (code 0, no signal); rejects on a
   * non-zero exit, a terminating signal, a spawn error, or the timeout. The
   * rejection message always carries the bounded stderr tail when there is one.
   */
  done: Promise<void>;
  /** Bounded stderr tail captured so far (useful for `lastError`). */
  stderrTail(): string;
  /** Force-terminate the child (SIGKILL). Safe to call after exit. */
  kill(): void;
}

/**
 * Spawn `command` and expose its stdout as a stream plus a `done` promise.
 *
 * The `settled` guard is load-bearing exactly as it is in the ffmpeg runner:
 * the SIGKILL issued on timeout makes the child emit its own 'close' (and
 * possibly 'error') afterwards, and those late events must not settle twice.
 *
 * EXPORTED for `pg-restore.util.ts` (#344). The restore side needs byte-for-byte
 * the same process handling — SIGKILL-guarded timeout, `settled` guard, bounded
 * stderr tail, `PGPASSWORD` never in argv — and re-implementing it there would
 * create a second copy of exactly the details that are easy to get subtly wrong.
 * It stays module-private in spirit: only the two `pg-*.util` modules call it.
 */
export function spawnPgProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: SpawnPgOptions,
  label: string,
): SpawnedPgProcess {
  const stderr = makeTailBuffer(STDERR_TAIL_MAX_CHARS);

  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let child: ChildProcess | null = null;

  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const settle = (err: Error | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (err) rejectDone(err);
    else resolveDone();
  };

  const withStderr = (message: string): Error => {
    const tail = stderr.get();
    return new Error(tail ? `${message}: ${tail}` : message);
  };

  try {
    child = spawnImpl(command, args, {
      env,
      // stdin is only written to for the pg_restore verification path; both
      // stdout and stderr must be pipes so they can be consumed here.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    settle(err instanceof Error ? err : new Error(String(err)));
  }

  if (child) {
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => stderr.append(chunk));
    child.stderr?.on('error', () => {});

    // An exiting child can make an in-flight stdin write emit EPIPE; that is
    // not a failure of the run, the exit code is.
    child.stdin?.on('error', () => {});

    child.on('error', (err: Error) => settle(err));

    // 'close' rather than 'exit': it fires only once stdio has also closed, so
    // the stderr tail is complete by the time the error message is built.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) {
        settle(withStderr(`${label} was killed with signal ${signal}`));
        return;
      }
      if (code) {
        settle(withStderr(`${label} exited with code ${code}`));
        return;
      }
      settle(null);
    });

    const timeoutMs = opts.timeoutMs;
    if (
      typeof timeoutMs === 'number' &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
    ) {
      timer = setTimeout(() => {
        try {
          child?.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        settle(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  }

  return {
    stdout: child?.stdout as Readable,
    stdin: (child?.stdin as Writable) ?? null,
    done,
    stderrTail: () => stderr.get(),
    kill: () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * Spawn `pg_dump`, streaming a custom-format archive on stdout.
 *
 * The caller MUST consume `stdout` (pipe it somewhere) — an unread pipe
 * applies backpressure and stalls the dump, which is the desired behaviour
 * while an upload catches up but a deadlock if nobody ever reads.
 */
export function spawnPgDump(
  cfg: PgConnectionConfig,
  compressionLevel: number,
  opts: SpawnPgOptions = {},
): SpawnedPgProcess {
  return spawnPgProcess(
    resolvePgDumpPath(),
    buildPgDumpArgs(cfg, compressionLevel),
    buildPgEnv(cfg),
    opts,
    'pg_dump',
  );
}

/**
 * Spawn `pg_restore --list` reading an archive from stdin — the post-upload
 * verification step. A clean exit means the archive header and TOC parsed,
 * which a truncated upload cannot do.
 *
 * No connection options are passed: `--list` is a pure archive read and never
 * touches a server. `PGPASSWORD` is still supplied for symmetry (and because a
 * future verification variant may connect), never argv.
 */
export function spawnPgRestoreList(
  cfg: PgConnectionConfig,
  opts: SpawnPgOptions = {},
): SpawnedPgProcess {
  return spawnPgProcess(
    resolvePgRestorePath(),
    buildPgRestoreListArgs(),
    buildPgEnv(cfg),
    opts,
    'pg_restore --list',
  );
}
