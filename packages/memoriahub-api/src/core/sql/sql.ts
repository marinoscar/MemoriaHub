import type { MemoriahubSql } from '../../ports/index.js';

// =============================================================================
// Structural Prisma helpers (RETRO-J4, #610)
// =============================================================================
//
// A slice builds raw SQL with `Prisma.sql`, `Prisma.raw` and `Prisma.join` without importing a
// generated client. They come from `@prisma/client-runtime-utils`, the package every Prisma 7 client
// builds its own `Sql` on, so a fragment built here is accepted by the host's `$queryRaw`. Both hosts
// run PostgreSQL, so slices keep their Postgres SQL (`pgvector`, `FOR UPDATE SKIP LOCKED`, JSONB).
//
// THE PEER IS OPTIONAL AND LOADED LAZILY: a host that never builds raw SQL does not install it, and
// merely importing this slice must not fail.
// =============================================================================

const RUNTIME_UTILS = '@prisma/client-runtime-utils';

interface RuntimeUtils {
  sql(strings: readonly string[], ...values: readonly unknown[]): MemoriahubSql;
  raw(value: string): MemoriahubSql;
  join(values: readonly unknown[], separator?: string, prefix?: string, suffix?: string): MemoriahubSql;
  empty: MemoriahubSql;
  DbNull: unknown;
  JsonNull: unknown;
}

let loaded: RuntimeUtils | undefined;

function runtimeUtils(): RuntimeUtils {
  if (loaded === undefined) {
    try {
      loaded = require(RUNTIME_UTILS) as RuntimeUtils;
    } catch (error) {
      throw new Error(
        `Building raw SQL needs the optional peer dependency ${RUNTIME_UTILS}; install it next to @prisma/client. (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  return loaded;
}

/**
 * The raw-SQL helpers, shaped like the `Prisma` namespace of a generated client.
 *
 * @example
 * ```ts
 * const rows = await prisma.$queryRaw(Prisma.sql`SELECT id FROM media_items WHERE circle_id = ${scopeId}::uuid`);
 * ```
 *
 * @stability experimental
 */
export const Prisma = Object.freeze({
  /**
   * A parameterised SQL template; every `${value}` becomes a bound parameter.
   *
   * @param strings - the template pieces.
   * @param values - the bound values.
   */
  sql: (strings: TemplateStringsArray, ...values: unknown[]): MemoriahubSql => runtimeUtils().sql(strings, ...values),

  /**
   * A raw SQL fragment inserted verbatim. Never pass user input.
   *
   * @param value - trusted SQL text.
   */
  raw: (value: string): MemoriahubSql => runtimeUtils().raw(value),

  /**
   * Joins values into a comma-separated (or custom-separated) fragment.
   *
   * @param values - the values or fragments.
   * @param separator - what goes between them; a comma by default.
   * @param prefix - what goes before the first.
   * @param suffix - what goes after the last.
   */
  join: (values: readonly unknown[], separator?: string, prefix?: string, suffix?: string): MemoriahubSql =>
    runtimeUtils().join(values, separator, prefix, suffix),

  /** An empty fragment. */
  get empty(): MemoriahubSql {
    return runtimeUtils().empty;
  },

  /** The value that writes SQL `NULL` into a nullable `jsonb` column (a bare `null` would be the JSON value `null`). */
  get DbNull(): unknown {
    return runtimeUtils().DbNull;
  },

  /** The value that writes the JSON value `null` into a `jsonb` column (distinct from SQL `NULL`). */
  get JsonNull(): unknown {
    return runtimeUtils().JsonNull;
  },
});
