// =============================================================================
// Memories — per-month candidate census (epic #300, issue #305)
// =============================================================================
//
// ONE aggregate query giving "how many curation candidates does this circle have
// in each calendar month", shared by the Seasonal and Year-in-Review curators.
//
// WHY AN AGGREGATE AND NOT A CANDIDATE SCAN. Both curators need the same
// question answered before they do any work: which periods even have enough
// material to be worth curating? Answering it by streaming candidates would mean
// paging the entire library through the engine just to discard most periods —
// for a 70k-item circle, once per curator. Grouping in the database instead
// returns at most `12 × years-of-history` rows (a couple of hundred), and the
// expensive `curate()` pass then runs only for periods that already cleared
// their `minItems` floor on raw counts.
//
// The `WHERE` clause is the curation base filter, hand-written here because this
// is raw SQL rather than a Prisma `where`. It MUST stay identical to
// `memoryCandidateBaseWhere()` — a census that counted archived or trashed items
// would send a curator off to curate a period that then comes back short. The
// integration suite asserts the two agree.
// =============================================================================

import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { monthBucket } from './period-windows';

/** Candidate count per `monthBucket()` key (`year * 12 + monthIndex`). */
export type MonthCounts = Map<number, number>;

/** Sum the census over a half-open instant range, month-granular. */
export function countInWindow(counts: MonthCounts, start: Date, endExclusive: Date): number {
  const from = monthBucket(start);
  // The window's end is exclusive and always lands on a month boundary for
  // every caller here (year and season windows both start on the 1st), so the
  // last month INCLUDED is the one before `endExclusive`'s bucket.
  const to = monthBucket(endExclusive) - 1;
  let total = 0;
  for (let bucket = from; bucket <= to; bucket += 1) total += counts.get(bucket) ?? 0;
  return total;
}

/** The earliest and latest months present, or null for an empty census. */
export function censusBounds(counts: MonthCounts): { first: number; last: number } | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const [bucket, count] of counts) {
    if (count <= 0) continue;
    if (bucket < first) first = bucket;
    if (bucket > last) last = bucket;
  }
  return Number.isFinite(first) ? { first, last } : null;
}

/** A `monthBucket` key back to the UTC instant its month starts at. */
export function monthBucketStart(bucket: number): Date {
  const year = Math.floor(bucket / 12);
  return new Date(Date.UTC(year, bucket - year * 12, 1));
}

/**
 * Count this circle's curation candidates per calendar month (UTC).
 *
 * Months with no candidates are simply absent from the map rather than present
 * with a zero, so `censusBounds` can read "has any data at all" straight off it.
 */
export async function loadMonthCounts(
  prisma: PrismaService,
  circleId: string,
): Promise<MonthCounts> {
  const rows = await prisma.$queryRaw<Array<{ year: number; month: number; count: number }>>(
    Prisma.sql`
      SELECT
        EXTRACT(YEAR  FROM ("captured_at" AT TIME ZONE 'UTC'))::int AS year,
        EXTRACT(MONTH FROM ("captured_at" AT TIME ZONE 'UTC'))::int AS month,
        COUNT(*)::int AS count
      FROM "media_items"
      WHERE "circle_id" = ${circleId}::uuid
        AND "captured_at" IS NOT NULL
        AND "deleted_at" IS NULL
        AND "archived_at" IS NULL
        AND "social_media_source" IS NULL
      GROUP BY 1, 2
    `,
  );

  const counts: MonthCounts = new Map();
  for (const row of rows) {
    // EXTRACT(MONTH) is 1-based; monthBucket() is built on getUTCMonth()'s
    // 0-based index, so the -1 here is what keeps the two representations
    // interchangeable.
    counts.set(row.year * 12 + (row.month - 1), row.count);
  }
  return counts;
}
