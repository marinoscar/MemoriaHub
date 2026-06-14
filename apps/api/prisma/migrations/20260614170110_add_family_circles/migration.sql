-- Family Circles migration: add circles, circle_members, circle_invites;
-- rename owner_id->added_by_id on media_items, albums, tags; add circle_id FKs;
-- swap partial unique index and tag unique constraint.
--
-- ATOMIC BACKFILL STRATEGY:
--   This migration creates the new tables, backfills a personal circle for
--   every existing user, then adds circle_id to media_items/albums/tags as
--   nullable, backfills it from the user's personal circle, and finally makes
--   it NOT NULL. All steps run in a single implicit transaction so the database
--   is never left in a partially migrated state.
--
-- DOWN DIRECTION (forward-only; documented for reference):
--   1. DROP INDEX "media_items_circle_content_hash_active_key";
--   2. CREATE UNIQUE INDEX "media_items_owner_content_hash_active_key"
--        ON "media_items" ("added_by_id", "content_hash")
--        WHERE "content_hash" IS NOT NULL AND "deleted_at" IS NULL;
--   3. DROP INDEX "tags_circle_id_name_key";
--   4. CREATE UNIQUE INDEX "tags_owner_id_name_key" ON "tags" ("added_by_id", "name");
--   5. ALTER TABLE "media_items" DROP CONSTRAINT "media_items_circle_id_fkey";
--      ALTER TABLE "albums"      DROP CONSTRAINT "albums_circle_id_fkey";
--      ALTER TABLE "tags"        DROP CONSTRAINT "tags_circle_id_fkey";
--   6. ALTER TABLE "media_items" DROP COLUMN "circle_id";
--      ALTER TABLE "albums"      DROP COLUMN "circle_id";
--      ALTER TABLE "tags"        DROP COLUMN "circle_id";
--   7. ALTER TABLE "media_items" RENAME COLUMN "added_by_id" TO "owner_id";
--      ALTER TABLE "albums"      RENAME COLUMN "added_by_id" TO "owner_id";
--      ALTER TABLE "tags"        RENAME COLUMN "added_by_id" TO "owner_id";
--   8. DROP TABLE "circle_invites";
--      DROP TABLE "circle_members";
--      DROP TABLE "circles";
--   9. DROP TYPE "CircleRole";
--
-- SCHEMA DRIFT NOTE (partial unique index):
--   The index "media_items_circle_content_hash_active_key" is intentionally
--   hand-authored and is NOT represented in schema.prisma. Prisma cannot
--   express partial unique indexes; a plain @@unique would wrongly constrain
--   NULL content_hash rows and would block re-importing soft-deleted photos.
--   This project uses `prisma migrate deploy` (not `migrate dev`) in all
--   non-local environments so Prisma never runs drift detection. In local
--   development `migrate dev` does detect drift; developers should NOT run
--   `migrate dev` after this migration without understanding this intentional
--   gap (same caveat as migration 20260612000000_add_media_content_hash_unique).

-- -----------------------------------------------------------------------------
-- Step 1: Create CircleRole enum and new tables
-- -----------------------------------------------------------------------------

CREATE TYPE "CircleRole" AS ENUM ('circle_admin', 'collaborator', 'viewer');

CREATE TABLE "circles" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "name"        TEXT        NOT NULL,
    "description" TEXT,
    "owner_id"    UUID        NOT NULL,
    "is_personal" BOOLEAN     NOT NULL DEFAULT false,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "circles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "circles_owner_id_fkey"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE INDEX "circles_owner_id_idx" ON "circles" ("owner_id");

CREATE TABLE "circle_members" (
    "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"  UUID        NOT NULL,
    "user_id"    UUID        NOT NULL,
    "role"       "CircleRole" NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "circle_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "circle_members_circle_id_user_id_key" UNIQUE ("circle_id", "user_id"),
    CONSTRAINT "circle_members_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "circle_members_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX "circle_members_user_id_idx"   ON "circle_members" ("user_id");
CREATE INDEX "circle_members_circle_id_idx" ON "circle_members" ("circle_id");

CREATE TABLE "circle_invites" (
    "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"    UUID        NOT NULL,
    "email"        TEXT        NOT NULL,
    "role"         "CircleRole" NOT NULL DEFAULT 'viewer',
    "added_by_id"  UUID,
    "added_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "claimed_by_id" UUID,
    "claimed_at"   TIMESTAMPTZ,
    "notes"        TEXT,

    CONSTRAINT "circle_invites_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "circle_invites_circle_id_email_key" UNIQUE ("circle_id", "email"),
    CONSTRAINT "circle_invites_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "circle_invites_added_by_id_fkey"
        FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "circle_invites_claimed_by_id_fkey"
        FOREIGN KEY ("claimed_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "circle_invites_email_idx"     ON "circle_invites" ("email");
CREATE INDEX "circle_invites_circle_id_idx" ON "circle_invites" ("circle_id");

-- -----------------------------------------------------------------------------
-- Step 2: Create one personal circle per existing user
-- -----------------------------------------------------------------------------

INSERT INTO "circles" ("id", "name", "is_personal", "owner_id", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    COALESCE("display_name", 'My') || '''s Library',
    true,
    "id",
    now(),
    now()
FROM "users";

-- -----------------------------------------------------------------------------
-- Step 3: Insert circle_members row: owner as circle_admin for each personal circle
-- -----------------------------------------------------------------------------

INSERT INTO "circle_members" ("id", "circle_id", "user_id", "role", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    c."id",
    c."owner_id",
    'circle_admin',
    now(),
    now()
FROM "circles" c
WHERE c."is_personal" = true;

-- -----------------------------------------------------------------------------
-- Step 4: Rename owner_id -> added_by_id on media_items, albums, tags
--         and add circle_id columns (nullable for now, backfilled below)
-- -----------------------------------------------------------------------------

ALTER TABLE "media_items" RENAME COLUMN "owner_id" TO "added_by_id";
ALTER TABLE "albums"      RENAME COLUMN "owner_id" TO "added_by_id";
ALTER TABLE "tags"        RENAME COLUMN "owner_id" TO "added_by_id";

ALTER TABLE "media_items" ADD COLUMN "circle_id" UUID;
ALTER TABLE "albums"      ADD COLUMN "circle_id" UUID;
ALTER TABLE "tags"        ADD COLUMN "circle_id" UUID;

-- -----------------------------------------------------------------------------
-- Step 5: Backfill circle_id from owner's personal circle
-- -----------------------------------------------------------------------------

UPDATE "media_items" m
SET "circle_id" = c."id"
FROM "circles" c
WHERE c."owner_id" = m."added_by_id"
  AND c."is_personal" = true;

UPDATE "albums" a
SET "circle_id" = c."id"
FROM "circles" c
WHERE c."owner_id" = a."added_by_id"
  AND c."is_personal" = true;

UPDATE "tags" t
SET "circle_id" = c."id"
FROM "circles" c
WHERE c."owner_id" = t."added_by_id"
  AND c."is_personal" = true;

-- -----------------------------------------------------------------------------
-- Step 6: Enforce NOT NULL + add FK constraints to circles
-- -----------------------------------------------------------------------------

ALTER TABLE "media_items" ALTER COLUMN "circle_id" SET NOT NULL;
ALTER TABLE "albums"      ALTER COLUMN "circle_id" SET NOT NULL;
ALTER TABLE "tags"        ALTER COLUMN "circle_id" SET NOT NULL;

ALTER TABLE "media_items"
    ADD CONSTRAINT "media_items_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE RESTRICT;

ALTER TABLE "albums"
    ADD CONSTRAINT "albums_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE RESTRICT;

ALTER TABLE "tags"
    ADD CONSTRAINT "tags_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- Step 7: Rebuild indexes and unique constraints
-- -----------------------------------------------------------------------------

-- media_items: drop old owner_id index; add circle_id and added_by_id indexes
DROP INDEX IF EXISTS "media_items_owner_id_idx";
CREATE INDEX "media_items_circle_id_idx"    ON "media_items" ("circle_id");
CREATE INDEX "media_items_added_by_id_idx"  ON "media_items" ("added_by_id");

-- albums: drop old owner_id index; add circle_id index
DROP INDEX IF EXISTS "albums_owner_id_idx";
CREATE INDEX "albums_circle_id_idx" ON "albums" ("circle_id");

-- tags: drop old unique on (owner_id, name); create on (circle_id, name)
--       drop old owner_id index; add circle_id index
DROP INDEX IF EXISTS "tags_owner_id_name_key";
DROP INDEX IF EXISTS "tags_owner_id_idx";
CREATE UNIQUE INDEX "tags_circle_id_name_key" ON "tags" ("circle_id", "name");
CREATE INDEX "tags_circle_id_idx" ON "tags" ("circle_id");

-- media_items partial unique: drop old (owner_id, content_hash) partial index;
-- create new (circle_id, content_hash) scoped to non-deleted rows.
-- See SCHEMA DRIFT NOTE above — this index is intentionally hand-authored.
DROP INDEX IF EXISTS "media_items_owner_content_hash_active_key";

-- CreateIndex (partial unique — intentionally not in schema.prisma)
CREATE UNIQUE INDEX "media_items_circle_content_hash_active_key"
    ON "media_items" ("circle_id", "content_hash")
    WHERE "content_hash" IS NOT NULL AND "deleted_at" IS NULL;
