/**
 * Synchronous database-reachability probe for DB-gated integration specs.
 *
 * ## Why this exists (issue #288)
 *
 * A DB-gated suite must report **skipped** when no database is reachable —
 * never **passed**. Getting that right is subtler than it looks, and two
 * plausible-looking gates both produce false greens:
 *
 *  1. **Env-var-only gate.** `.env.test` declares `POSTGRES_HOST`
 *     unconditionally, so `!!process.env.POSTGRES_HOST` is true even with no
 *     server listening. The `describe` block runs.
 *
 *  2. **Async probe in `beforeAll`.** Jest fixes which `describe`/`it` blocks
 *     are registered — and therefore whether a suite reports "skipped" vs.
 *     "passed" — at MODULE-EVALUATION time, which completes synchronously
 *     before any `beforeAll` body runs. By the time an async probe resolves,
 *     the suite has already been registered as a normal `describe`. The usual
 *     fallback is then a per-test guard whose body is
 *     `expect(true).toBe(true); return;` — and that is a genuine PASS. A suite
 *     asserting nothing while reporting green is exactly the defect this
 *     module exists to prevent.
 *
 * The fix is a probe that is **synchronous and evaluated at module load**, so
 * a real `describe.skip` can be chosen before Jest registers anything. There
 * is then nothing left for a per-test guard to do — `skipIfNoDb`-style
 * wrappers should not exist alongside this.
 *
 * ## Usage
 *
 *   const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;
 *
 *   describeMaybeDb('… (DB_GATED: real PostgreSQL)', () => {
 *     let prisma: PrismaClient;
 *     beforeAll(async () => { prisma = …; await prisma.$connect(); });
 *     …
 *   });
 *
 * Inside the block the database is known to be reachable, so `prisma` can be
 * non-nullable and every test can assume it — no null checks, no guards.
 *
 * ## How the probe works
 *
 * Node has no synchronous socket API, so we spawn a throwaway Node subprocess
 * that attempts a `net.connect` and exits 0 on success / 1 on
 * error-or-timeout, and read its exit code synchronously via `execFileSync`.
 * ANY failure (non-zero exit, spawn error, the outer `execFileSync` timeout)
 * is treated as "database unavailable" rather than propagating — a probe that
 * throws would fail the whole file instead of skipping it.
 *
 * This checks that something is LISTENING on the port, not that it is
 * Postgres, that credentials work, or that migrations have been applied. That
 * is deliberate: it is the cheap check that distinguishes "no database here"
 * from "database here", and a suite that then fails to connect or finds a
 * missing table SHOULD fail loudly rather than silently skip.
 */

import { execFileSync } from 'child_process';

/** Connection details a probe needs, resolved from the usual env vars. */
export interface DbProbeTarget {
  host: string;
  port: number;
}

/**
 * Resolve the probe target the same way `PrismaService` resolves its
 * connection: `DATABASE_URL` wins when set, otherwise the discrete
 * `POSTGRES_*` variables, with the same defaults.
 */
export function resolveDbProbeTarget(): DbProbeTarget | null {
  const url = process.env['DATABASE_URL'];
  if (url) {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, port: Number(parsed.port || 5432) };
    } catch {
      // An unparseable DATABASE_URL is a misconfiguration, not a reachable DB.
      return null;
    }
  }

  const host = process.env['POSTGRES_HOST'];
  if (!host) {
    // Neither variable set: no DB configured at all (e.g. a plain unit-test
    // run). Short-circuit before paying for a subprocess spawn.
    return null;
  }
  return { host, port: parseInt(process.env['POSTGRES_PORT'] ?? '5432', 10) };
}

/**
 * Is a server listening on the resolved Postgres host/port?
 *
 * MUST be called at module scope, before `describe` is registered — see this
 * module's header for why a `beforeAll` is structurally too late.
 */
export function isDatabaseReachable(timeoutMs = 1500): boolean {
  const target = resolveDbProbeTarget();
  if (!target) {
    return false;
  }

  const script = `
    const net = require('net');
    const socket = new net.Socket();
    const fail = () => { socket.destroy(); process.exit(1); };
    socket.setTimeout(${timeoutMs});
    socket.once('error', fail);
    socket.once('timeout', fail);
    socket.connect(${target.port}, ${JSON.stringify(target.host)}, () => {
      socket.destroy();
      process.exit(0);
    });
  `;

  try {
    execFileSync(process.execPath, ['-e', script], {
      stdio: 'ignore',
      timeout: timeoutMs + 1000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `describe` when a database is reachable, `describe.skip` otherwise.
 *
 * Evaluated eagerly at import time, which is precisely the point: importing
 * this constant at module scope gives the caller a gate that is already
 * decided by the time Jest registers its suite.
 */
export const describeMaybeDb: jest.Describe = isDatabaseReachable()
  ? describe
  : describe.skip;
