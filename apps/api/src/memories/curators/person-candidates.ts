// =============================================================================
// Memories — shared person queries (epic #300, issue #305)
// =============================================================================
//
// The two people curators — `person_highlights` (best of X, per year) and
// `person_over_years` (X through the years) — ask the library the SAME two
// questions before they diverge: which persons are eligible at all, and how many
// candidates does each have per year? Both live here so the two curators cannot
// drift on eligibility, which is the rule with the most policy in it.
//
// ELIGIBILITY IS A CIRCLE-LEVEL FACT, NOT A PER-USER ONE. A person qualifies
// when they are live (`deletedAt IS NULL`), not circle-hidden
// (`hiddenAt IS NULL`), identifiable (a non-empty name OR a cover face), and —
// when `memories.people.favoritesOnly` is on, which is the default — marked
// `favorite`. Deliberately ABSENT: per-user hidden-people preferences. Memories
// are circle-scoped content generated once for everyone; whose faces a given
// user does not want to see is read-time filtering, and belongs to #307. Baking
// a per-user preference into generation would mean either generating per user
// (N× the rows and the cost) or letting whoever ran first decide for everybody.
//
// THE PER-YEAR CENSUS IS ONE GROUPED QUERY FOR THE WHOLE CIRCLE, for the same
// reason `circle-month-counts.ts` exists: the alternative is streaming every
// person's candidates through the engine just to discover most person-years are
// under `minItems`. The grouped form returns `persons × years-with-data` rows —
// a few hundred — and the expensive `curate()` pass then runs only where it can
// actually produce a memory.
// =============================================================================

import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CuratedSelection } from '../curation/memory-curation.types';

const logger = new Logger('PersonMemoryCandidates');

/**
 * Ceiling on eligible persons considered in one generation pass.
 *
 * Only reachable with `favoritesOnly = false` in a circle with a very large
 * cluster population, where the work would otherwise be `persons × years`
 * curation passes. Ordered deterministically (favorites first, then by id) so
 * the cut is stable across runs rather than reshuffling which persons get
 * memories. A crash guard, not a tuning knob.
 */
export const MAX_ELIGIBLE_PERSONS = 500;

/** Minimum distinct years of material before `person_over_years` is meaningful. */
export const PERSON_OVER_YEARS_MIN_YEARS = 3;

/**
 * Ceiling on items taken from any single year in `person_over_years`.
 *
 * The memory is a span, not an album: four photos from one prolific year is
 * plenty, and the budget freed by the cap is what lets quiet years appear at
 * all. Per issue #305 ("best 2–4 items per year").
 */
export const PERSON_OVER_YEARS_MAX_PER_YEAR = 4;

/** An eligible person, reduced to what the curators actually use. */
export interface EligiblePerson {
  id: string;
  name: string | null;
}

/** Candidate count for one `(person, calendar year)` pair. */
export interface PersonYearCount {
  personId: string;
  year: number;
  count: number;
}

/**
 * Persons in this circle that may receive memories.
 *
 * The identifiability rule (`name` OR `coverFace`) is applied in SQL as
 * "either column is non-null" and then tightened in memory to reject a
 * whitespace-only name — Prisma cannot express `trim(name) <> ''`, and a person
 * named `"   "` with no cover face would otherwise get a "Best of" memory
 * titled after nothing.
 */
export async function loadEligiblePersons(
  prisma: PrismaService,
  circleId: string,
  favoritesOnly: boolean,
): Promise<EligiblePerson[]> {
  const rows = await prisma.person.findMany({
    where: {
      circleId,
      deletedAt: null,
      hiddenAt: null,
      ...(favoritesOnly ? { favorite: true } : {}),
      OR: [{ name: { not: null } }, { coverFaceId: { not: null } }],
    },
    // Favorites first so the MAX_ELIGIBLE_PERSONS cut, if it ever bites, keeps
    // the persons the circle explicitly cares about.
    orderBy: [{ favorite: 'desc' }, { id: 'asc' }],
    take: MAX_ELIGIBLE_PERSONS + 1,
    select: { id: true, name: true, coverFaceId: true },
  });

  if (rows.length > MAX_ELIGIBLE_PERSONS) {
    logger.warn(
      `Circle ${circleId} has more than ${MAX_ELIGIBLE_PERSONS} eligible persons; ` +
        'people memories were generated for the first page only',
    );
  }

  return rows
    .slice(0, MAX_ELIGIBLE_PERSONS)
    .filter((p) => (p.name?.trim().length ?? 0) > 0 || p.coverFaceId !== null)
    .map((p) => ({ id: p.id, name: p.name }));
}

/**
 * Candidate counts per `(person, year)` for the given persons, in one query.
 *
 * `COUNT(DISTINCT m.id)` because a media item may carry several faces of the
 * same person (a video's cross-frame identity rows, or a genuine second
 * detection) and it is still one photo in the memory.
 *
 * `f.hidden_at IS NULL` mirrors the archive semantics of the face-level hide
 * (`PATCH /api/people/faces/bulk/hide`): an archived face is not evidence the
 * person is in that photo any more, so it must not qualify a year the person is
 * effectively absent from.
 *
 * The `WHERE` on `media_items` is the curation base filter, hand-written here
 * for the same reason as in `circle-month-counts.ts` — see that file's header.
 */
export async function loadPersonYearCounts(
  prisma: PrismaService,
  circleId: string,
  personIds: string[],
): Promise<PersonYearCount[]> {
  if (personIds.length === 0) return [];

  return prisma.$queryRaw<PersonYearCount[]>(Prisma.sql`
    SELECT
      f."person_id" AS "personId",
      EXTRACT(YEAR FROM (m."captured_at" AT TIME ZONE 'UTC'))::int AS "year",
      COUNT(DISTINCT m."id")::int AS "count"
    FROM "faces" f
    JOIN "media_items" m ON m."id" = f."media_item_id"
    WHERE f."circle_id" = ${circleId}::uuid
      AND f."person_id" = ANY(${personIds}::uuid[])
      AND f."hidden_at" IS NULL
      AND m."circle_id" = ${circleId}::uuid
      AND m."captured_at" IS NOT NULL
      AND m."deleted_at" IS NULL
      AND m."archived_at" IS NULL
      AND m."social_media_source" IS NULL
    GROUP BY 1, 2
  `);
}

/** Group a flat census by person, each person's years sorted ascending. */
export function groupYearCounts(
  counts: PersonYearCount[],
): Map<string, Array<{ year: number; count: number }>> {
  const byPerson = new Map<string, Array<{ year: number; count: number }>>();
  for (const row of counts) {
    const bucket = byPerson.get(row.personId);
    if (bucket) bucket.push({ year: row.year, count: row.count });
    else byPerson.set(row.personId, [{ year: row.year, count: row.count }]);
  }
  for (const bucket of byPerson.values()) bucket.sort((a, b) => a.year - b.year);
  return byPerson;
}

/**
 * The curated item that shows this person BEST: the one carrying their
 * highest-confidence face.
 *
 * Per issue #305, a person memory's cover should be a photo of that person
 * rather than the engine's generic "highest-scored non-video item" — which, in a
 * memory built from group shots, can easily be the frame where they are a blur
 * in the background.
 *
 * Videos are excluded here for the same reason `finalizeSelection` excludes
 * them: a cover is rendered as a still. Returns null when nothing qualifies
 * (an all-video selection, or faces with NULL confidence only) and the caller
 * keeps the engine's cover.
 */
export async function preferredPersonCover(
  prisma: PrismaService,
  personId: string,
  selection: CuratedSelection,
): Promise<string | null> {
  const ids = selection.items.map((item) => item.mediaItemId);
  if (ids.length === 0) return null;

  const best = await prisma.face.findFirst({
    where: {
      personId,
      hiddenAt: null,
      mediaItemId: { in: ids },
      mediaItem: { type: 'photo' },
    },
    // NULL confidence sorts LAST rather than first (Postgres' default for DESC),
    // so a scored face always beats an unscored one; the id tiebreak keeps the
    // choice stable across runs over an unchanged library.
    orderBy: [{ confidence: { sort: 'desc', nulls: 'last' } }, { mediaItemId: 'asc' }],
    select: { mediaItemId: true },
  });

  return best?.mediaItemId ?? null;
}

/** Replace a selection's cover, leaving the rest of it untouched. */
export function withCover(selection: CuratedSelection, coverMediaItemId: string | null): CuratedSelection {
  if (!coverMediaItemId) return selection;
  return { ...selection, coverMediaItemId };
}
