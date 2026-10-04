-- Add a generated "display date" column to media_items plus a partial
-- composite index so the gallery can keyset-paginate on it (issue #549).
--
-- WHY: GET /api/media (keyset mode) ordered by captured_at DESC, id DESC.
-- Postgres sorts NULLs FIRST on DESC, so every undated item (no EXIF capture
-- date) floated to the very top of the gallery, ordered by its random UUID,
-- while the web UI buckets those same items by imported_at. The result was a
-- gallery whose order disagreed with its own date headings. The fix is to
-- order by the date the UI actually displays:
--   display_at = COALESCE(captured_at, imported_at)
-- imported_at is NOT NULL, so display_at is NEVER NULL, which also removes
-- every NULLS FIRST/LAST subtlety from the keyset cursor.
--
-- WHY A STORED GENERATED COLUMN (not an expression index):
--   Prisma cannot ORDER BY or cursor on an expression, but it can on a real
--   column. A GENERATED ALWAYS ... STORED column is maintained by Postgres
--   itself, so no application code writes it and it can never drift from
--   captured_at / imported_at (EXIF re-extraction, manual date edits and
--   bulk date edits all keep it correct for free).
--
-- LOCKING / COST NOTE:
--   ADD COLUMN ... GENERATED ALWAYS AS (...) STORED forces a full table
--   rewrite under an ACCESS EXCLUSIVE lock (a stored generated column cannot
--   be added as a metadata-only change). At ~70k media_items rows this takes
--   a second or two, which is acceptable for a deploy-time migration. The
--   index build that follows holds a SHARE lock (writes blocked) for a
--   similarly short time. If this table ever grows by orders of magnitude,
--   run it during a maintenance window (see docs/runbooks/maintenance-mode.md).
--
-- WHY THIS PARTIAL PREDICATE / KEY ORDER:
--   Mirrors media_items_gallery_idx (migration 20260716000000): the partial
--   WHERE (non-deleted, non-archived) matches the default gallery query, and
--   (circle_id, display_at DESC, id DESC) matches
--   ORDER BY display_at DESC, id DESC exactly, so the query is a pure index
--   scan with no sort node and the keyset predicate
--   (display_at, id) < (cursor) is evaluated against the index order.
--   The older media_items_gallery_idx is deliberately LEFT IN PLACE: other
--   code paths may still order by captured_at, and dropping it is a separate,
--   reversible follow-up once nothing uses it.
--
-- SCHEMA DRIFT NOTE:
--   The index is hand-authored raw SQL: Prisma's schema DSL cannot express a
--   partial index or DESC key ordering, so it is intentionally invisible to
--   schema.prisma (same precedent as media_items_gallery_idx,
--   media_items_map_locations_idx and idx_media_circle_device_captured). The
--   COLUMN itself IS declared in schema.prisma (MediaItem.displayAt, with
--   dbgenerated() so Prisma never includes it in an INSERT/UPDATE). The
--   project uses `prisma migrate deploy` in all non-local environments, so
--   no drift-detection step runs; do not run `migrate dev` after this
--   migration without understanding this intentional gap.
--
-- DOWN DIRECTION (rollback; run manually, Prisma has no down migrations):
--   DROP INDEX "media_items_display_gallery_idx";
--   ALTER TABLE "media_items" DROP COLUMN "display_at";

-- AlterTable (stored generated column; rewrites the table)
ALTER TABLE "media_items"
  ADD COLUMN "display_at" timestamptz
  GENERATED ALWAYS AS (COALESCE("captured_at", "imported_at")) STORED;

-- CreateIndex (partial, composite)
CREATE INDEX "media_items_display_gallery_idx"
  ON "media_items" ("circle_id", "display_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL AND "archived_at" IS NULL;
