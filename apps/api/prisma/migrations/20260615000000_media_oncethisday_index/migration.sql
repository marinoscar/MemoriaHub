-- Add functional index on (MONTH(captured_at), DAY(captured_at)) for non-deleted MediaItems.
--
-- INTENT: Accelerate the "On This Day" dashboard query, which filters rows where
-- EXTRACT(MONTH FROM (captured_at AT TIME ZONE 'UTC')) = $month
-- AND EXTRACT(DAY FROM (captured_at AT TIME ZONE 'UTC')) = $day
-- while excluding soft-deleted items (deleted_at IS NULL). Without this index the
-- planner would do a full sequential scan of media_items for every dashboard load.
--
-- WHY AT TIME ZONE 'UTC' IS REQUIRED:
--   captured_at is a timestamptz (timestamp with time zone) column. PostgreSQL
--   marks EXTRACT(field FROM timestamptz) as only STABLE (not IMMUTABLE) because
--   its output can depend on the session timezone setting. Index expressions MUST
--   be IMMUTABLE. The fix is to first cast to a plain timestamp by applying
--   AT TIME ZONE 'UTC', which yields a timestamp (no tz). EXTRACT on a plain
--   timestamp IS immutable, allowing the index to be created successfully.
--   This migration previously failed with:
--     ERROR: functions in index expression must be marked IMMUTABLE
--   The fix is correct here because the dashboard query already computes today's
--   month/day using getUTCMonth()/getUTCDate(), so UTC is the intended semantics.
--
-- WHY A HAND-AUTHORED MIGRATION (not schema.prisma):
--   Prisma's schema DSL has no syntax for functional/expression indexes. The
--   expressions cannot appear in a @@index() directive; only plain column names
--   are supported. Attempting to add this via schema.prisma would create a plain
--   B-tree index on the timestamp column itself — useless for this pattern.
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
-- NOTE: (captured_at AT TIME ZONE 'UTC') casts timestamptz → timestamp so that
-- EXTRACT becomes IMMUTABLE (required for index expressions in PostgreSQL).
CREATE INDEX "media_items_captured_md_idx"
  ON "media_items" (
    EXTRACT(MONTH FROM ("captured_at" AT TIME ZONE 'UTC')),
    EXTRACT(DAY FROM ("captured_at" AT TIME ZONE 'UTC'))
  )
  WHERE "deleted_at" IS NULL;
