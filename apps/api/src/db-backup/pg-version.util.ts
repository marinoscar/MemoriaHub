/**
 * PostgreSQL client-vs-server version guard (issue #364, epic #339).
 *
 * WHY THIS FILE EXISTS AT ALL. `apps/api/Dockerfile` pinned
 * `postgresql-client-16` while the live server ran 17.10. `pg_dump` refuses,
 * by design, to dump a server whose major is NEWER than its own — so the entire
 * database-backup engine could never have produced a single archive on that
 * image. The invariant it violated (`client major >= server major`) was written
 * down only as a comment in the Dockerfile, and a comment cannot fail a build,
 * fail a run, or show up in Doctor. That is precisely how it shipped broken.
 * This module turns that comment into code, consumed at three call sites so the
 * mismatch is reported BEFORE it costs anyone a backup window:
 *
 *   1. `DatabaseBackupRunnerService.executeRun` — hard-fails the run early with
 *      an actionable `lastError` instead of letting `pg_dump` fail opaquely
 *      minutes later, after a storage key has already been claimed.
 *   2. `DatabaseRestoreService.preflight` — a `capability.pg_client_version`
 *      check that routes an incompatible image into the EXISTING `guided` mode,
 *      which already hands the admin a paste-ready command block.
 *   3. `DoctorService` — `core.pgClientVersion`, so an operator sees the problem
 *      on a routine health sweep rather than during an incident.
 *
 * THE RUNTIME COMPARISON IS ALWAYS AGAINST THE LIVE SERVER, never against
 * {@link MIN_PG_CLIENT_MAJOR}. That constant is a BUILD-time floor for the
 * image; the thing that actually breaks a dump is the relationship between the
 * client binary in this container and whatever server this deployment happens
 * to point at, which no constant can know.
 *
 * DELIBERATE POLICY — AN `unknown` VERDICT WARNS AND PROCEEDS, NEVER BLOCKS.
 * Every input here can legitimately be unavailable: `pg_dump` may not be on
 * PATH in a stripped image, `--version` output formatting is not a stability
 * contract, and `server_version_num` is read through a connection that may
 * itself be failing. Refusing to back up because a version string did not parse
 * would convert a cosmetic unknown into a real outage — and it would be
 * redundant, because a genuinely incompatible pair still produces `pg_dump`'s
 * own unambiguous "server version mismatch" error through the ordinary failure
 * path. Only a POSITIVELY established `client < server` blocks anything.
 *
 * Everything here is pure or trivially seam-able: the version probe goes
 * through `pg-dump.util.ts`'s existing {@link spawnPgProcess} + its
 * `__setSpawnForTests` seam rather than spawning directly, for exactly the
 * reason that module gives — an explicit, documented seam beats module-level
 * mocking of a Node builtin.
 */

import {
  resolvePgDumpPath,
  spawnPgProcess,
  type SpawnedPgProcess,
} from './pg-dump.util';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The PostgreSQL client major the built image is expected to carry.
 *
 * BUILD-TIME FLOOR ONLY. Nothing at runtime compares against this — the runtime
 * guards below compare the client against the LIVE server, because that is the
 * relationship `pg_dump` actually enforces. This constant exists so the number
 * pinned in `apps/api/Dockerfile` (`postgresql-client-17`) has a single machine-
 * readable expression that the CI image gate in `.github/workflows/deploy.yml`
 * can assert against the built image, in the same spirit as its existing
 * `REQUIRE_HEIC_DECODE` / `REQUIRE_CLIP_MODEL` gates.
 *
 * Raising it is a Dockerfile change first and this constant second.
 */
export const MIN_PG_CLIENT_MAJOR = 17;

/**
 * Timeout for the `<binary> --version` probe.
 *
 * `--version` neither connects nor reads anything; it prints one line and
 * exits. A ceiling this generous only ever fires for a genuinely wedged exec
 * (an unreadable mount, a hung NFS PATH entry), and even then the failure is a
 * benign `null` rather than a blocked backup.
 */
export const PG_VERSION_PROBE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/**
 * Extract the major version from `pg_dump --version` / `pg_restore --version`
 * output.
 *
 * The shapes this must survive, all of them real:
 *   `pg_dump (PostgreSQL) 17.10`
 *   `pg_restore (PostgreSQL) 16.4`
 *   `pg_dump (PostgreSQL) 18beta1`                     — pre-release, no dot
 *   `pg_dump (PostgreSQL) 17.10 (Debian 17.10-1.pgdg13+1)`  — PGDG packaging
 *
 * The last one is why the pattern is anchored on the literal `(PostgreSQL)`
 * marker rather than "first number in the string": a naive scan would happily
 * read the Debian package revision, and on some vendor builds that is a
 * different number than the server-relevant major.
 *
 * @returns the major (e.g. `17`), or `null` for anything unrecognisable —
 *   which callers must treat as `unknown`, never as a failure.
 */
export function parsePgVersionMajor(output: string): number | null {
  if (!output) return null;

  const match = /\(PostgreSQL\)\s+(\d+)/i.exec(output);
  if (!match) return null;

  const major = Number.parseInt(match[1]!, 10);
  // `\d+` cannot produce NaN, but a 0 major is meaningless and would compare
  // as "client older than everything"; reject it rather than block on it.
  return Number.isFinite(major) && major > 0 ? major : null;
}

/**
 * Derive the major from Postgres' `server_version_num` integer, whose encoding
 * is `major * 10000 + minor` for 10+ (so 170010 → 17, 160004 → 16).
 *
 * Kept as bare arithmetic, with the `SELECT current_setting('server_version_num')::int`
 * left at the call sites: each of them already owns a Prisma (or admin) client
 * and its own error-handling posture, and threading a client in here would buy
 * nothing but a harder-to-test module.
 */
export function readServerMajor(serverVersionNum: number | null): number | null {
  if (serverVersionNum === null || !Number.isFinite(serverVersionNum)) {
    return null;
  }
  const major = Math.floor(serverVersionNum / 10000);
  return major > 0 ? major : null;
}

// ---------------------------------------------------------------------------
// Verdict + shared wording
// ---------------------------------------------------------------------------

/**
 * `ok`           — client major >= server major; `pg_dump` will run.
 * `client_older` — POSITIVELY established mismatch; the only blocking verdict.
 * `unknown`      — either side could not be determined. Warn and proceed.
 */
export type PgVersionVerdict = 'ok' | 'client_older' | 'unknown';

export function compareClientToServer(
  clientMajor: number | null,
  serverMajor: number | null,
): PgVersionVerdict {
  if (clientMajor === null || serverMajor === null) return 'unknown';
  return clientMajor < serverMajor ? 'client_older' : 'ok';
}

/**
 * The single wording for the mismatch, shared by all three call sites.
 *
 * Centralised on purpose: three hand-written variants of the same sentence
 * drift, and this particular sentence is the one an admin reads mid-incident
 * out of `lastError`, a preflight report, or a Doctor row — it must say the
 * same thing in all three.
 */
export function pgVersionMismatchMessage(
  clientMajor: number,
  serverMajor: number,
): string {
  return (
    `pg_dump/pg_restore is PostgreSQL ${clientMajor}.x but the database server is ${serverMajor}.x. ` +
    'pg_dump refuses to dump a server newer than itself.'
  );
}

/** Companion remediation for {@link pgVersionMismatchMessage}. */
export const PG_VERSION_ACTION_ITEM =
  'Rebuild the API image with postgresql-client-17 (or newer) — see apps/api/Dockerfile.';

// ---------------------------------------------------------------------------
// Client probe (memoised)
// ---------------------------------------------------------------------------

/**
 * Per-process memo, keyed by RESOLVED binary path.
 *
 * The client binary cannot change under a running process, so probing it more
 * than once is pure waste — and this is called from a Doctor sweep that may run
 * repeatedly. The cached value is the PROMISE, not the resolved number, so
 * concurrent callers (Doctor's parallel check catalog is exactly that) share
 * one spawn instead of racing several.
 *
 * Keyed by path rather than a single slot because `PG_DUMP_PATH` /
 * `PG_RESTORE_PATH` make the binary configurable, and a test that flips one
 * must not read the other's answer.
 */
const clientMajorCache = new Map<string, Promise<number | null>>();

/**
 * TEST-ONLY seam: drop the memo so specs are not order-dependent.
 * Production code must never call this.
 */
export function __resetPgVersionCacheForTests(): void {
  clientMajorCache.clear();
}

/**
 * Read the major version of a PostgreSQL client binary by running
 * `<binary> --version`.
 *
 * @param binary defaults to {@link resolvePgDumpPath} — `pg_dump` and
 *   `pg_restore` come from the same package, so probing one answers for both.
 * @returns the major, or `null` on ANY failure (binary missing, spawn error,
 *   non-zero exit, timeout, unparseable output). Never throws: every caller's
 *   contract is that an unreadable version is an `unknown` verdict, not an
 *   error, and a probe that could throw would push that policy decision out to
 *   three separate try/catch blocks.
 */
export async function readPgClientMajor(
  binary?: string,
): Promise<number | null> {
  const resolved = binary ?? resolvePgDumpPath();

  const cached = clientMajorCache.get(resolved);
  if (cached) return cached;

  const probe = probeClientMajor(resolved);
  clientMajorCache.set(resolved, probe);
  return probe;
}

async function probeClientMajor(binary: string): Promise<number | null> {
  let proc: SpawnedPgProcess;
  try {
    proc = spawnPgProcess(
      binary,
      ['--version'],
      // No `PGPASSWORD`: `--version` prints a string and exits without ever
      // opening a connection, so there is no credential to supply.
      process.env,
      { timeoutMs: PG_VERSION_PROBE_TIMEOUT_MS },
      `${binary} --version`,
    );
  } catch {
    return null;
  }

  // `spawnPgProcess` hands stdout back as a live stream and never collects it
  // (its raison d'être is the multi-GB dump that must NOT be buffered). Here
  // the output is one short line, so collecting it is the correct thing — and
  // it must be collected, because an unread pipe would apply backpressure and
  // stall even this trivial child. `stdout` is `undefined` when the spawn threw
  // synchronously, in which case `done` is already rejected and there is
  // nothing to read.
  let output = '';
  const { stdout } = proc;
  if (stdout) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    // A destroyed/errored pipe must not become an unhandled 'error' event; the
    // exit status carried by `done` is the authority on whether this worked.
    stdout.on('error', () => {});
  }

  try {
    await proc.done;
  } catch {
    return null;
  }

  return parsePgVersionMajor(output);
}
