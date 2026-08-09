-- Widened functional index serving the Memories "On This Day" curator
-- (epic #300, issue #303).
--
-- INTENT: OnThisDayCurator asks, per anchor day and per circle, "which items in
-- THIS circle were captured on month M / day D of any past year?" — and the
-- admin backfill (#315) additionally asks "which (month, day) pairs does this
-- circle have any candidate on at all?" (a DISTINCT scan). Both are
-- circle-scoped and both exclude archived items, neither of which the existing
-- "media_items_captured_md_idx" covers:
--
--   media_items_captured_md_idx  (20260615000000_media_oncethisday_index)
--     ON media_items (EXTRACT(MONTH …), EXTRACT(DAY …)) WHERE deleted_at IS NULL
--
-- That index has no leading circle_id, so a circle-scoped query has to scan
-- every circle's rows for the matching calendar day and then filter — fine for
-- the single-circle dashboard it was built for, wasteful for a per-circle
-- generation job that runs this twice per circle per pass. It also cannot serve
-- the backfill's DISTINCT (month, day) scan at all, since that needs circle_id
-- as the leading key to bound the scan to one circle.
--
-- This index leads with circle_id and folds the two remaining curation base
-- filter predicates (archived_at IS NULL, captured_at IS NOT NULL) into the
-- partial predicate, so the whole On This Day candidate query — and the
-- backfill's anchor-discovery scan — is served directly.
--
-- WHY THE EXISTING INDEX IS KEPT: MediaService.getDashboard still issues the
-- un-scoped-by-archive variant, and dropping it would regress that path. The
-- two coexist; the planner picks per query.
--
-- WHY AT TIME ZONE 'UTC' IS REQUIRED:
--   captured_at is timestamptz, and PostgreSQL marks EXTRACT(field FROM
--   timestamptz) only STABLE (its result depends on the session TimeZone), while
--   index expressions must be IMMUTABLE. Casting to a plain timestamp with
--   AT TIME ZONE 'UTC' first makes EXTRACT immutable. This matches the UTC
--   semantics the curator itself uses (it derives anchors via getUTCFullYear /
--   getUTCMonth / getUTCDate), so the index expression and the query agree
--   exactly — a mismatch here would silently produce a full sequential scan.
--
-- WHY A HAND-AUTHORED MIGRATION (not schema.prisma):
--   Prisma's schema DSL has no syntax for functional/expression indexes; an
--   @@index() directive accepts only plain column names and would produce a
--   plain B-tree on the timestamp column, useless for this access pattern.
--
-- SCHEMA DRIFT NOTE:
--   Intentionally not represented in schema.prisma — the same documented drift
--   as media_items_captured_md_idx, media_items_gallery_idx,
--   media_items_map_locations_idx, people_circle_id_hidden_at_idx and the
--   review_run_items partial uniques. The project runs `prisma migrate deploy`
--   (never `migrate dev`) outside local development, so no drift-detection step
--   runs against it.
--
-- DOWN DIRECTION:
--   DROP INDEX "media_items_circle_captured_md_idx";

-- CreateIndex (functional, partial, circle-scoped)
CREATE INDEX IF NOT EXISTS "media_items_circle_captured_md_idx"
  ON "media_items" (
    "circle_id",
    EXTRACT(MONTH FROM ("captured_at" AT TIME ZONE 'UTC')),
    EXTRACT(DAY   FROM ("captured_at" AT TIME ZONE 'UTC'))
  )
  WHERE "deleted_at" IS NULL
    AND "archived_at" IS NULL
    AND "captured_at" IS NOT NULL;
