-- Add partial unique index on (owner_id, content_hash) for active MediaItems.
--
-- INTENT: Enforce at the database level that a user cannot have two non-deleted
-- MediaItems with the same content hash (byte-identical deduplication backstop).
--
-- WHY A PARTIAL INDEX (not @@unique in schema.prisma):
--   Prisma's @@unique directive does not support filtered/partial indexes.
--   A plain @@unique([ownerId, contentHash]) would wrongly constrain NULL
--   content_hash rows (only one NULL per owner would be allowed, because NULL
--   equality semantics differ from unique-index NULL handling in some DBs), and
--   would prevent a user from re-adding a previously soft-deleted photo (two rows
--   with the same hash, one deleted and one active, must be allowed).
--   The WHERE predicate solves both problems:
--     • content_hash IS NOT NULL  → rows with no hash are never constrained
--     • deleted_at IS NULL        → soft-deleted rows are excluded so a user can
--                                   re-import a photo they previously trashed
--
-- SCHEMA DRIFT NOTE:
--   This index is intentionally hand-authored and is NOT represented in
--   schema.prisma. Prisma cannot express partial unique indexes; adding a
--   @@unique directive here would produce incorrect behaviour (see above).
--   The project uses `prisma migrate deploy` (not `migrate dev`) in all
--   non-local environments, so Prisma never runs a drift-detection step that
--   would error out. In local development `migrate dev` does detect drift; to
--   avoid spurious warnings the developer should NOT run `migrate dev` after
--   this migration is applied without first understanding this intentional gap.
--   The existing plain index (media_items_content_hash_idx) is retained for
--   query performance on `?contentHash=` filter lookups; this partial unique
--   index adds the enforcement guarantee on top.

-- CreateIndex (partial unique)
CREATE UNIQUE INDEX "media_items_owner_content_hash_active_key"
  ON "media_items" ("owner_id", "content_hash")
  WHERE "content_hash" IS NOT NULL AND "deleted_at" IS NULL;
