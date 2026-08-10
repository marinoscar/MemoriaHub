-- Profile Picture Management (issue #354) — schema-only foundation. Adds:
--   1. UserAvatarSource enum — where a user's active avatar image comes
--      from: their OAuth provider (default, current behavior), a direct
--      upload, or a linked Person's profile photo.
--   2. Four additive, nullable-or-defaulted columns on "users": no backfill
--      is required since every existing row is correctly represented by the
--      'oauth' default and null avatar/link columns.
--   3. A nullable self-service link from a user to a Person record in one of
--      their circles (avatar source 'person'), FK'd with ON DELETE SET NULL
--      so a deleted/merged Person never blocks or cascades into the user
--      row — mirrors the existing "people" nullable-FK precedent elsewhere
--      in this schema (e.g. burst_groups.suggested_best_item_id).
--   4. An index on the new FK column, matching the existing convention of
--      indexing every FK on this schema.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "UserAvatarSource" AS ENUM ('oauth', 'upload', 'person');

-- -----------------------------------------------------------------------------
-- AlterTable: users
-- -----------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN "avatar_source"      "UserAvatarSource" NOT NULL DEFAULT 'oauth';
ALTER TABLE "users" ADD COLUMN "avatar_storage_key" TEXT;
ALTER TABLE "users" ADD COLUMN "avatar_version"     TEXT;
ALTER TABLE "users" ADD COLUMN "linked_person_id"   UUID;

-- -----------------------------------------------------------------------------
-- AddForeignKey
-- -----------------------------------------------------------------------------

ALTER TABLE "users" ADD CONSTRAINT "users_linked_person_id_fkey"
  FOREIGN KEY ("linked_person_id")
  REFERENCES "people"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- CreateIndex
-- -----------------------------------------------------------------------------

CREATE INDEX "users_linked_person_id_idx" ON "users"("linked_person_id");
