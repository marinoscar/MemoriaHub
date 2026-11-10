// =============================================================================
// Shared pieces of MemoriaHub's export sources (RETRO-H2, #596)
// =============================================================================
//
// WHAT "MY CONTENT" MEANS (Open decision 1 of #596, the recommended answer):
//
//   * everything in the user's PERSONAL circle (`circles.is_personal` and
//     `circles.owner_id = user`), whoever added it (only the owner is a member
//     of a personal circle, so in practice that is the user), and
//   * what the user ADDED anywhere else (`added_by_id = user`), but never
//     inside ANOTHER user's personal circle.
//
// Circle-wide exports for circle administrators wait for Epic I (group scope).
//
// Every source reads through the bypass client (`ExportContext.db`), which lifts
// row-level security, so the `where` built here IS the boundary: each one names
// the user explicitly. Rows are paged by id (keyset, `ctx.pageSize` per page) and
// projected column by column: a source never forwards a row as the database
// returned it, so a column it does not list (a hash, a storage key, an embedding)
// cannot reach a file even if a client ignored `select`.
// =============================================================================

import type { ExportCell, ExportColumn, ExportColumnType, ExportDb } from '@marinoscar/platform-api/exports';

/** The permission every MemoriaHub source requires: what `GET /api/media` enforces, held by every role. */
export const MEMORIAHUB_EXPORT_PERMISSION = 'media:read';

/** The column types MemoriaHub's datasets use (no `date`: civil timestamps are written as text). */
export const MEMORIAHUB_EXPORT_COLUMN_TYPES: readonly ExportColumnType[] = ['string', 'number', 'boolean', 'datetime'];

/**
 * Rows of a library-content model (`MediaItem`, `Album`, `Person`): everything in the
 * user's personal library (`owner_user_id`), plus what the user added in a shared
 * library (a group-owned row). A row the user added inside SOMEONE ELSE's personal
 * library is never included. The owner columns decide it (RETRO-K1), not `circles`.
 */
export function ownedCircleContentWhere(userId: string): Record<string, unknown> {
  return {
    OR: [{ ownerUserId: userId }, { addedById: userId, ownerGroupId: { not: null } }],
  };
}

export { OWNER_NAME_SELECT, libraryName } from '../sharing/owner-name';

/** A column. */
export function column(key: string, label: string, type: ExportColumnType = 'string'): ExportColumn {
  return { key, label, type };
}

/**
 * A CIVIL timestamp (`captured_at`, `memories.period_start`, ...) as the gallery shows
 * it: the stored UTC wall clock, WITHOUT a zone (`2026-06-20T20:16:07`). Ingest
 * re-encodes the camera's tz-naive EXIF clock as UTC, so the value is not an instant;
 * rendering it as one (with a `Z`, or converted to the reader's zone by a spreadsheet)
 * would shift a photo near midnight onto another day. See docs/specs/date-model.md.
 */
export function civilTimestamp(value: unknown): ExportCell {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 19);
}

/** An INSTANT (`created_at`, `archived_at`, ...) as ISO 8601 UTC. */
export function instant(value: unknown): ExportCell {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

/** A text cell; anything that is not a string is `null`. */
export function text(value: unknown): ExportCell {
  return typeof value === 'string' ? value : null;
}

/** A number cell; a `BigInt` becomes its decimal text (file sizes past 2^53 stay exact). */
export function num(value: unknown): ExportCell {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** A `BigInt` (or number) as decimal text. */
export function bigText(value: unknown): ExportCell {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return null;
}

/** A boolean cell. */
export function bool(value: unknown): ExportCell {
  return typeof value === 'boolean' ? value : null;
}

/** Distinct, non-empty names joined with `; `, sorted (stable output for a diff). */
export function joinNames(names: readonly unknown[]): ExportCell {
  const distinct = [...new Set(names.filter((n): n is string => typeof n === 'string' && n.trim() !== ''))];
  distinct.sort((a, b) => a.localeCompare(b));
  return distinct.length === 0 ? null : distinct.join('; ');
}

/** What `pageById` needs of a query. */
export interface PagedQuery {
  /** The delegate name on the client (`mediaItem`). */
  readonly delegate: string;
  /** The rows to read; the user filter. */
  readonly where: Record<string, unknown>;
  /** The columns (and relations) to read. Must include `id`. */
  readonly select: Record<string, unknown>;
}

/**
 * The rows of `query`, read `pageSize` at a time in id order (keyset: `id > last`),
 * yielded one by one. Never loads a table.
 */
export async function* pageById(
  db: ExportDb,
  query: PagedQuery,
  pageSize: number,
): AsyncGenerator<Record<string, unknown>> {
  const delegate = db[query.delegate];
  if (!delegate) throw new Error(`The export client has no "${query.delegate}" delegate`);
  const take = Math.max(1, pageSize);
  let cursor: string | null = null;
  for (;;) {
    const where: Record<string, unknown> =
      cursor === null ? query.where : { AND: [query.where, { id: { gt: cursor } }] };
    const rows = (await delegate.findMany({
      where,
      select: { ...query.select, id: true },
      orderBy: { id: 'asc' },
      take,
    })) as Record<string, unknown>[];
    for (const row of rows) yield row;
    if (rows.length < take) return;
    const last = rows[rows.length - 1]!.id;
    if (typeof last !== 'string') return;
    cursor = last;
  }
}
