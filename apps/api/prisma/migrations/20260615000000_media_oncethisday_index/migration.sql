-- Add functional index on (MONTH(captured_at), DAY(captured_at)) for non-deleted MediaItems.
--
-- INTENT: Accelerate the "On This Day" dashboard query, which filters rows where
-- EXTRACT(MONTH FROM captured_at) = $month AND EXTRACT(DAY FROM captured_at) = $day
-- while excluding soft-deleted items (deleted_at IS NULL). Without this index the
-- planner would do a full sequential scan of media_items for every dashboard load.
--
-- WHY A HAND-AUTHORED MIGRATION (not schema.prisma):
--   Prisma's schema DSL has no syntax for functional/expression indexes. The
--   expressions EXTRACT(MONTH FROM "captured_at") and EXTRACT(DAY FROM "captured_at")
--   cannot appear in a @@index() directive; only plain column names are supported.
--   Attempting to add this via schema.prisma would require falling back to a raw
--   column name, which would create a plain B-tree index on the timestamp column
--   itself — useless for the month/day extraction pattern used by the query.
--
-- DOWN DIRECTION:
--   DROP INDEX "media_items_captured_md_idx";
--
-- SCHEMA DRIFT NOTE:
--   This index is intentionally hand-authored and is NOT represented in
--   schema.prisma. Prisma cannot express functional indexes; adding a @@index
--   directive here would produce the wrong index definition (see above).
--   The project uses `prisma migrate deploy` (not `migrate dev`) in all
--   non-local environments, so Prisma never runs a drift-detection step that
--   would error out. In local development `migrate dev` does detect drift; to
--   avoid spurious warnings the developer should NOT run `migrate dev` after
--   this migration is applied without first understanding this intentional gap.

-- CreateIndex (functional, partial)
CREATE INDEX "media_items_captured_md_idx"
  ON "media_items" (EXTRACT(MONTH FROM "captured_at"), EXTRACT(DAY FROM "captured_at"))
  WHERE "deleted_at" IS NULL;
