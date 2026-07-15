/**
 * Shared, pure helpers for constructing the PostgreSQL connection URL used by
 * Prisma. Extracted so both `configuration.ts` (which sets
 * `process.env.DATABASE_URL` early) and `PrismaService` route through the same
 * logic — including the connection-pool sizing params that make Prisma's
 * pool behave predictably inside a CPU-limited container (Prisma's default
 * `connection_limit` is host-derived, `num_cpus*2+1`, which is misleading in a
 * container that pins CPU below the host count).
 *
 * These functions are intentionally pure and env-injectable for unit testing.
 */

type EnvLike = Record<string, string | undefined>;

/** Default connection pool size when `DB_CONNECTION_LIMIT` is unset. */
const DEFAULT_CONNECTION_LIMIT = 10;
/** Default pool acquisition timeout (seconds) when `DB_POOL_TIMEOUT` is unset. */
const DEFAULT_POOL_TIMEOUT = 20;

/**
 * Parse an env value into a positive integer.
 * Returns `undefined` for empty/missing/invalid/non-positive values so callers
 * can distinguish "unset" (apply default) from "explicitly bad" (skip).
 */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return undefined;
  }
  return n;
}

/**
 * Build the base PostgreSQL URL from POSTGRES_* variables.
 * If `env.DATABASE_URL` is already set, it is returned verbatim as the base.
 * The password is URL-encoded to tolerate special characters.
 */
export function buildBaseDatabaseUrl(env: EnvLike = process.env): string {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }

  const host = env.POSTGRES_HOST ?? 'localhost';
  const port = env.POSTGRES_PORT ?? '5432';
  const user = env.POSTGRES_USER ?? 'postgres';
  const password = env.POSTGRES_PASSWORD ?? 'postgres';
  const dbName = env.POSTGRES_DB ?? 'appdb';
  const ssl = env.POSTGRES_SSL === 'true';
  const sslParam = ssl ? '?sslmode=require' : '';

  const encodedPassword = encodeURIComponent(password);

  return `postgresql://${user}:${encodedPassword}@${host}:${port}/${dbName}${sslParam}`;
}

/**
 * Append connection-pool params (`connection_limit`, `pool_timeout`) to a
 * database URL.
 *
 * - Uses `?` if the URL has no query string yet, else `&`.
 * - Idempotent: if `connection_limit=` is already present, the URL is returned
 *   unchanged (so applying this in both `configuration.ts` and `PrismaService`
 *   is safe — the second call is a no-op).
 * - Each param is appended only when its env var yields a valid positive
 *   integer; an empty/invalid value is skipped, but the documented default is
 *   applied when the env var is unset entirely.
 */
export function appendPoolParams(url: string, env: EnvLike = process.env): string {
  // Idempotency guard: never append pool params twice.
  if (url.includes('connection_limit=')) {
    return url;
  }

  const params: string[] = [];

  const connLimitRaw = env.DB_CONNECTION_LIMIT;
  const connLimit =
    connLimitRaw === undefined
      ? DEFAULT_CONNECTION_LIMIT
      : parsePositiveInt(connLimitRaw);
  if (connLimit !== undefined) {
    params.push(`connection_limit=${connLimit}`);
  }

  const poolTimeoutRaw = env.DB_POOL_TIMEOUT;
  const poolTimeout =
    poolTimeoutRaw === undefined
      ? DEFAULT_POOL_TIMEOUT
      : parsePositiveInt(poolTimeoutRaw);
  if (poolTimeout !== undefined) {
    params.push(`pool_timeout=${poolTimeout}`);
  }

  if (params.length === 0) {
    return url;
  }

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params.join('&')}`;
}

/**
 * Build the full PostgreSQL URL (base + pool params).
 */
export function buildDatabaseUrl(env: EnvLike = process.env): string {
  return appendPoolParams(buildBaseDatabaseUrl(env), env);
}

/**
 * Resolve the runtime `pg` pool configuration from the same env vars the URL
 * pool params derive from.
 *
 * IMPORTANT: the `@prisma/adapter-pg` driver adapter runs on a real `pg.Pool`.
 * When `PrismaPg` is given a bare connection STRING it does
 * `new pg.Pool({ connectionString })` — and `pg` does NOT honor Prisma's
 * `connection_limit` / `pool_timeout` URL query params (those only affect
 * Prisma's own query engine, i.e. the CLI/migration path). So to actually size
 * the runtime pool we must pass `pg.PoolConfig` fields:
 *   - `max`                    ← the pg equivalent of `connection_limit`
 *   - `connectionTimeoutMillis`← the pg equivalent of `pool_timeout` (seconds → ms)
 *
 * Defaults mirror `appendPoolParams`: 10 connections, 20s wait.
 */
export function resolvePoolConfig(env: EnvLike = process.env): {
  max: number;
  connectionTimeoutMillis: number;
} {
  const max = parsePositiveInt(env.DB_CONNECTION_LIMIT) ?? DEFAULT_CONNECTION_LIMIT;
  const poolTimeoutSec = parsePositiveInt(env.DB_POOL_TIMEOUT) ?? DEFAULT_POOL_TIMEOUT;
  return {
    max,
    connectionTimeoutMillis: poolTimeoutSec * 1000,
  };
}
