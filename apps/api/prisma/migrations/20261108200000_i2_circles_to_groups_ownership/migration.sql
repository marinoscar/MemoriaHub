-- =============================================================================
-- RETRO-I2 (#569): circles -> platform groups, and content ownership
-- =============================================================================
--
-- The mapping is docs/platform-adoption/circles-to-groups.md (RETRO-I1); the
-- operator procedure, expected timings and verification queries are
-- docs/runbooks/circles-to-groups.md.
--
-- ADDITIVE. Nothing is dropped: circles, circle_members and every circle_id
-- column stay, and circles keep deciding access until RETRO-I3. What this adds:
--
--   1. groups / group_members: one group per NON-personal circle, with the SAME
--      uuid (decision 1), and one member row per membership of it
--      (circle_admin -> admin, collaborator -> editor, viewer -> viewer). A group
--      left without an admin gets its circle owner as admin (the slice refuses
--      to leave a group without one: LAST_GROUP_ADMIN). A personal circle
--      becomes no group: its rows become user-owned.
--   2. org_id (NOT NULL, the default organization), owner_group_id and
--      owner_user_id on the 20 content tables and media_visual_embedding, with
--      CHECK (num_nonnulls(owner_user_id, owner_group_id) = 1), the composite
--      key (owner_group_id, org_id) -> groups (id, org_id) ON DELETE RESTRICT,
--      owner_user_id -> users ON DELETE RESTRICT (a personal library never
--      cascades away with a user row; the user-data removal hook empties it
--      first, as it empties the personal circle today), org_id -> organizations,
--      two btree indexes, ENABLE + FORCE ROW LEVEL SECURITY and the platform's
--      <table>_org_isolation policy (platform.lock rlsPolicies).
--   3. PLATFORM-ADOPTION-SHIM(#573) triggers that keep the two models equal while
--      the application still writes circles and circle_id:
--        mh_owner_from_circle     BEFORE INSERT OR UPDATE OF circle_id on every
--                                 content table: derives the owner from circle_id
--                                 (so every writer, raw SQL and createMany
--                                 included, fills the new columns, and
--                                 move_to_circle re-owns the row);
--        mh_circle_mirror_group   circles -> groups (insert, rename, delete);
--        mh_circle_member_mirror  circle_members -> group_members;
--        mh_group_mirror_guard    refuses deleting a group whose circle exists.
--      RETRO-I3 (access on groups) and RETRO-I5 (invites) drop them with the
--      circle columns.
--
-- RE-RUNNABLE: every statement is guarded (IF NOT EXISTS, DROP ... IF EXISTS,
-- ON CONFLICT, WHERE org_id IS NULL), so replaying the file on a migrated
-- database changes nothing (proved by test/sharing/ownership.db.spec.ts).
-- One transaction under app.rls_bypass: groups, group_members and the content
-- tables are FORCE RLS tables, and a bare statement would see no row.
-- =============================================================================

BEGIN;
SELECT set_config('app.rls_bypass', 'on', true);
-- The HNSW rebuilds of step 2 run far faster when the graph fits in memory; raise the
-- transaction's maintenance_work_mem to 256MB when the server's is lower (a larger
-- database-level value set by the operator is kept; docs/runbooks/circles-to-groups.md §2).
SELECT set_config('maintenance_work_mem', '256MB', true)
WHERE pg_size_bytes(current_setting('maintenance_work_mem')) < pg_size_bytes('256MB');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The default organization (single-organization mode, organizations_default_uniq_idx).
CREATE OR REPLACE FUNCTION mh_default_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT id FROM organizations WHERE is_default LIMIT 1 $$;

-- CircleRole -> group role (circles-to-groups.md §2).
CREATE OR REPLACE FUNCTION mh_circle_role_to_group_role(role text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT CASE role WHEN 'circle_admin' THEN 'admin' WHEN 'collaborator' THEN 'editor' ELSE 'viewer' END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM circles) AND mh_default_org_id() IS NULL THEN
    RAISE EXCEPTION 'RETRO-I2: circles exist but no default organization (organizations.is_default); run the identity migrations first';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Circles -> groups, members -> group members
-- ---------------------------------------------------------------------------

INSERT INTO "groups" ("id", "org_id", "name", "description", "created_by_id", "version", "created_at", "updated_at")
SELECT c."id", mh_default_org_id(), c."name", c."description", c."owner_id", 1, c."created_at", c."updated_at"
FROM "circles" c
WHERE NOT c."is_personal"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "group_members" ("id", "group_id", "user_id", "org_id", "role", "created_at", "updated_at")
SELECT gen_random_uuid(), m."circle_id", m."user_id", g."org_id", mh_circle_role_to_group_role(m."role"::text), m."created_at", m."updated_at"
FROM "circle_members" m
JOIN "circles" c ON c."id" = m."circle_id" AND NOT c."is_personal"
JOIN "groups" g ON g."id" = m."circle_id"
ON CONFLICT ("group_id", "user_id") DO NOTHING;

-- A group with no admin gets its circle's owner as admin.
INSERT INTO "group_members" ("id", "group_id", "user_id", "org_id", "role", "created_at", "updated_at")
SELECT gen_random_uuid(), c."id", c."owner_id", g."org_id", 'admin', now(), now()
FROM "circles" c
JOIN "groups" g ON g."id" = c."id"
WHERE NOT c."is_personal"
  AND NOT EXISTS (SELECT 1 FROM "group_members" gm WHERE gm."group_id" = c."id" AND gm."role" = 'admin')
ON CONFLICT ("group_id", "user_id") DO UPDATE SET "role" = 'admin', "updated_at" = now();

-- ---------------------------------------------------------------------------
-- 2. Ownership columns, backfill, constraints, indexes, row-level security
-- ---------------------------------------------------------------------------

-- media_items
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "media_items" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_items" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_items have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_items" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_items" DROP CONSTRAINT IF EXISTS "media_items_one_owner_check";
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_items" DROP CONSTRAINT IF EXISTS "media_items_org_id_fkey";
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_items" DROP CONSTRAINT IF EXISTS "media_items_owner_group_id_org_id_fkey";
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_items" DROP CONSTRAINT IF EXISTS "media_items_owner_user_id_fkey";
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_items_owner_group_id_idx" ON "media_items"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_items_owner_user_id_idx" ON "media_items"("owner_user_id");
ALTER TABLE "media_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_items_org_isolation" ON "media_items";
CREATE POLICY "media_items_org_isolation" ON "media_items"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- albums
ALTER TABLE "albums" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "albums" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "albums" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of albums have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "albums" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "albums" DROP CONSTRAINT IF EXISTS "albums_one_owner_check";
ALTER TABLE "albums" ADD CONSTRAINT "albums_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "albums" DROP CONSTRAINT IF EXISTS "albums_org_id_fkey";
ALTER TABLE "albums" ADD CONSTRAINT "albums_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "albums" DROP CONSTRAINT IF EXISTS "albums_owner_group_id_org_id_fkey";
ALTER TABLE "albums" ADD CONSTRAINT "albums_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "albums" DROP CONSTRAINT IF EXISTS "albums_owner_user_id_fkey";
ALTER TABLE "albums" ADD CONSTRAINT "albums_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "albums_owner_group_id_idx" ON "albums"("owner_group_id");
CREATE INDEX IF NOT EXISTS "albums_owner_user_id_idx" ON "albums"("owner_user_id");
ALTER TABLE "albums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "albums" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "albums_org_isolation" ON "albums";
CREATE POLICY "albums_org_isolation" ON "albums"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- tags
ALTER TABLE "tags" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "tags" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "tags" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of tags have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "tags" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_one_owner_check";
ALTER TABLE "tags" ADD CONSTRAINT "tags_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_org_id_fkey";
ALTER TABLE "tags" ADD CONSTRAINT "tags_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_owner_group_id_org_id_fkey";
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_owner_user_id_fkey";
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "tags_owner_group_id_idx" ON "tags"("owner_group_id");
CREATE INDEX IF NOT EXISTS "tags_owner_user_id_idx" ON "tags"("owner_user_id");
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tags_org_isolation" ON "tags";
CREATE POLICY "tags_org_isolation" ON "tags"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- people
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "people" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "people" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of people have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "people" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "people" DROP CONSTRAINT IF EXISTS "people_one_owner_check";
ALTER TABLE "people" ADD CONSTRAINT "people_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "people" DROP CONSTRAINT IF EXISTS "people_org_id_fkey";
ALTER TABLE "people" ADD CONSTRAINT "people_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "people" DROP CONSTRAINT IF EXISTS "people_owner_group_id_org_id_fkey";
ALTER TABLE "people" ADD CONSTRAINT "people_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "people" DROP CONSTRAINT IF EXISTS "people_owner_user_id_fkey";
ALTER TABLE "people" ADD CONSTRAINT "people_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "people_owner_group_id_idx" ON "people"("owner_group_id");
CREATE INDEX IF NOT EXISTS "people_owner_user_id_idx" ON "people"("owner_user_id");
ALTER TABLE "people" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "people" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "people_org_isolation" ON "people";
CREATE POLICY "people_org_isolation" ON "people"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- faces
ALTER TABLE "faces" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
-- Rebuilt below, after the backfill; only when there is something to backfill (a replay keeps them).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "faces" WHERE "org_id" IS NULL) THEN
    DROP INDEX IF EXISTS "faces_embedding_vec_hnsw_idx";
    DROP INDEX IF EXISTS "faces_embedding_vec_archive_hnsw_idx";
    DROP INDEX IF EXISTS "faces_embedding_vec_assigned_hnsw_idx";
  END IF;
END $$;
UPDATE "faces" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "faces" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of faces have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "faces" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "faces" DROP CONSTRAINT IF EXISTS "faces_one_owner_check";
ALTER TABLE "faces" ADD CONSTRAINT "faces_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "faces" DROP CONSTRAINT IF EXISTS "faces_org_id_fkey";
ALTER TABLE "faces" ADD CONSTRAINT "faces_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faces" DROP CONSTRAINT IF EXISTS "faces_owner_group_id_org_id_fkey";
ALTER TABLE "faces" ADD CONSTRAINT "faces_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "faces" DROP CONSTRAINT IF EXISTS "faces_owner_user_id_fkey";
ALTER TABLE "faces" ADD CONSTRAINT "faces_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "faces_owner_group_id_idx" ON "faces"("owner_group_id");
CREATE INDEX IF NOT EXISTS "faces_owner_user_id_idx" ON "faces"("owner_user_id");
CREATE INDEX IF NOT EXISTS "faces_embedding_vec_hnsw_idx" ON "faces" USING hnsw ("embedding_vec" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS "faces_embedding_vec_archive_hnsw_idx" ON "faces" USING hnsw ("embedding_vec" vector_cosine_ops) WHERE "person_id" IS NULL AND "hidden_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "faces_embedding_vec_assigned_hnsw_idx" ON "faces" USING hnsw ("embedding_vec" vector_cosine_ops) WITH (m = 16, ef_construction = 64) WHERE "person_id" IS NOT NULL AND "embedding_vec" IS NOT NULL;
ALTER TABLE "faces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "faces" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "faces_org_isolation" ON "faces";
CREATE POLICY "faces_org_isolation" ON "faces"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- memories
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "memories" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "memories" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of memories have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "memories" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "memories_one_owner_check";
ALTER TABLE "memories" ADD CONSTRAINT "memories_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "memories_org_id_fkey";
ALTER TABLE "memories" ADD CONSTRAINT "memories_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "memories_owner_group_id_org_id_fkey";
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "memories_owner_user_id_fkey";
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "memories_owner_group_id_idx" ON "memories"("owner_group_id");
CREATE INDEX IF NOT EXISTS "memories_owner_user_id_idx" ON "memories"("owner_user_id");
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "memories_org_isolation" ON "memories";
CREATE POLICY "memories_org_isolation" ON "memories"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- media_item_embedding
ALTER TABLE "media_item_embedding" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
-- Rebuilt below, after the backfill; only when there is something to backfill (a replay keeps them).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "media_item_embedding" WHERE "org_id" IS NULL) THEN
    DROP INDEX IF EXISTS "media_item_embedding_hnsw_idx";
  END IF;
END $$;
UPDATE "media_item_embedding" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
-- No foreign key on media_item_embedding.circle_id: a row whose circle is gone takes its media item's.
UPDATE "media_item_embedding" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "media_items" mi JOIN "circles" c ON c."id" = mi."circle_id"
WHERE mi."id" = t."media_item_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_item_embedding" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_item_embedding have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_item_embedding" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_item_embedding" DROP CONSTRAINT IF EXISTS "media_item_embedding_one_owner_check";
ALTER TABLE "media_item_embedding" ADD CONSTRAINT "media_item_embedding_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_item_embedding" DROP CONSTRAINT IF EXISTS "media_item_embedding_org_id_fkey";
ALTER TABLE "media_item_embedding" ADD CONSTRAINT "media_item_embedding_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_item_embedding" DROP CONSTRAINT IF EXISTS "media_item_embedding_owner_group_id_org_id_fkey";
ALTER TABLE "media_item_embedding" ADD CONSTRAINT "media_item_embedding_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_item_embedding" DROP CONSTRAINT IF EXISTS "media_item_embedding_owner_user_id_fkey";
ALTER TABLE "media_item_embedding" ADD CONSTRAINT "media_item_embedding_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_item_embedding_owner_group_id_idx" ON "media_item_embedding"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_item_embedding_owner_user_id_idx" ON "media_item_embedding"("owner_user_id");
CREATE INDEX IF NOT EXISTS "media_item_embedding_hnsw_idx" ON "media_item_embedding" USING hnsw ("embedding" vector_cosine_ops);
ALTER TABLE "media_item_embedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_item_embedding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_item_embedding_org_isolation" ON "media_item_embedding";
CREATE POLICY "media_item_embedding_org_isolation" ON "media_item_embedding"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- media_geocode_status
ALTER TABLE "media_geocode_status" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "media_geocode_status" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_geocode_status" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_geocode_status have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_geocode_status" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_geocode_status" DROP CONSTRAINT IF EXISTS "media_geocode_status_one_owner_check";
ALTER TABLE "media_geocode_status" ADD CONSTRAINT "media_geocode_status_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_geocode_status" DROP CONSTRAINT IF EXISTS "media_geocode_status_org_id_fkey";
ALTER TABLE "media_geocode_status" ADD CONSTRAINT "media_geocode_status_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_geocode_status" DROP CONSTRAINT IF EXISTS "media_geocode_status_owner_group_id_org_id_fkey";
ALTER TABLE "media_geocode_status" ADD CONSTRAINT "media_geocode_status_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_geocode_status" DROP CONSTRAINT IF EXISTS "media_geocode_status_owner_user_id_fkey";
ALTER TABLE "media_geocode_status" ADD CONSTRAINT "media_geocode_status_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_geocode_status_owner_group_id_idx" ON "media_geocode_status"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_geocode_status_owner_user_id_idx" ON "media_geocode_status"("owner_user_id");
ALTER TABLE "media_geocode_status" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_geocode_status" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_geocode_status_org_isolation" ON "media_geocode_status";
CREATE POLICY "media_geocode_status_org_isolation" ON "media_geocode_status"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- media_metadata_status
ALTER TABLE "media_metadata_status" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "media_metadata_status" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_metadata_status" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_metadata_status have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_metadata_status" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_metadata_status" DROP CONSTRAINT IF EXISTS "media_metadata_status_one_owner_check";
ALTER TABLE "media_metadata_status" ADD CONSTRAINT "media_metadata_status_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_metadata_status" DROP CONSTRAINT IF EXISTS "media_metadata_status_org_id_fkey";
ALTER TABLE "media_metadata_status" ADD CONSTRAINT "media_metadata_status_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_metadata_status" DROP CONSTRAINT IF EXISTS "media_metadata_status_owner_group_id_org_id_fkey";
ALTER TABLE "media_metadata_status" ADD CONSTRAINT "media_metadata_status_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_metadata_status" DROP CONSTRAINT IF EXISTS "media_metadata_status_owner_user_id_fkey";
ALTER TABLE "media_metadata_status" ADD CONSTRAINT "media_metadata_status_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_metadata_status_owner_group_id_idx" ON "media_metadata_status"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_metadata_status_owner_user_id_idx" ON "media_metadata_status"("owner_user_id");
ALTER TABLE "media_metadata_status" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_metadata_status" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_metadata_status_org_isolation" ON "media_metadata_status";
CREATE POLICY "media_metadata_status_org_isolation" ON "media_metadata_status"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- media_tag_status
ALTER TABLE "media_tag_status" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "media_tag_status" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_tag_status" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_tag_status have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_tag_status" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_tag_status" DROP CONSTRAINT IF EXISTS "media_tag_status_one_owner_check";
ALTER TABLE "media_tag_status" ADD CONSTRAINT "media_tag_status_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_tag_status" DROP CONSTRAINT IF EXISTS "media_tag_status_org_id_fkey";
ALTER TABLE "media_tag_status" ADD CONSTRAINT "media_tag_status_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_tag_status" DROP CONSTRAINT IF EXISTS "media_tag_status_owner_group_id_org_id_fkey";
ALTER TABLE "media_tag_status" ADD CONSTRAINT "media_tag_status_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_tag_status" DROP CONSTRAINT IF EXISTS "media_tag_status_owner_user_id_fkey";
ALTER TABLE "media_tag_status" ADD CONSTRAINT "media_tag_status_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_tag_status_owner_group_id_idx" ON "media_tag_status"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_tag_status_owner_user_id_idx" ON "media_tag_status"("owner_user_id");
ALTER TABLE "media_tag_status" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_tag_status" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_tag_status_org_isolation" ON "media_tag_status";
CREATE POLICY "media_tag_status_org_isolation" ON "media_tag_status"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- media_transcripts
ALTER TABLE "media_transcripts" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "media_transcripts" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_transcripts" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_transcripts have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_transcripts" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_transcripts" DROP CONSTRAINT IF EXISTS "media_transcripts_one_owner_check";
ALTER TABLE "media_transcripts" ADD CONSTRAINT "media_transcripts_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_transcripts" DROP CONSTRAINT IF EXISTS "media_transcripts_org_id_fkey";
ALTER TABLE "media_transcripts" ADD CONSTRAINT "media_transcripts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_transcripts" DROP CONSTRAINT IF EXISTS "media_transcripts_owner_group_id_org_id_fkey";
ALTER TABLE "media_transcripts" ADD CONSTRAINT "media_transcripts_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_transcripts" DROP CONSTRAINT IF EXISTS "media_transcripts_owner_user_id_fkey";
ALTER TABLE "media_transcripts" ADD CONSTRAINT "media_transcripts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_transcripts_owner_group_id_idx" ON "media_transcripts"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_transcripts_owner_user_id_idx" ON "media_transcripts"("owner_user_id");
ALTER TABLE "media_transcripts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_transcripts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_transcripts_org_isolation" ON "media_transcripts";
CREATE POLICY "media_transcripts_org_isolation" ON "media_transcripts"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- burst_groups
ALTER TABLE "burst_groups" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "burst_groups" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "burst_groups" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of burst_groups have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "burst_groups" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "burst_groups" DROP CONSTRAINT IF EXISTS "burst_groups_one_owner_check";
ALTER TABLE "burst_groups" ADD CONSTRAINT "burst_groups_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "burst_groups" DROP CONSTRAINT IF EXISTS "burst_groups_org_id_fkey";
ALTER TABLE "burst_groups" ADD CONSTRAINT "burst_groups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "burst_groups" DROP CONSTRAINT IF EXISTS "burst_groups_owner_group_id_org_id_fkey";
ALTER TABLE "burst_groups" ADD CONSTRAINT "burst_groups_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "burst_groups" DROP CONSTRAINT IF EXISTS "burst_groups_owner_user_id_fkey";
ALTER TABLE "burst_groups" ADD CONSTRAINT "burst_groups_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "burst_groups_owner_group_id_idx" ON "burst_groups"("owner_group_id");
CREATE INDEX IF NOT EXISTS "burst_groups_owner_user_id_idx" ON "burst_groups"("owner_user_id");
ALTER TABLE "burst_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "burst_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "burst_groups_org_isolation" ON "burst_groups";
CREATE POLICY "burst_groups_org_isolation" ON "burst_groups"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- duplicate_groups
ALTER TABLE "duplicate_groups" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "duplicate_groups" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "duplicate_groups" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of duplicate_groups have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "duplicate_groups" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "duplicate_groups" DROP CONSTRAINT IF EXISTS "duplicate_groups_one_owner_check";
ALTER TABLE "duplicate_groups" ADD CONSTRAINT "duplicate_groups_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "duplicate_groups" DROP CONSTRAINT IF EXISTS "duplicate_groups_org_id_fkey";
ALTER TABLE "duplicate_groups" ADD CONSTRAINT "duplicate_groups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "duplicate_groups" DROP CONSTRAINT IF EXISTS "duplicate_groups_owner_group_id_org_id_fkey";
ALTER TABLE "duplicate_groups" ADD CONSTRAINT "duplicate_groups_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "duplicate_groups" DROP CONSTRAINT IF EXISTS "duplicate_groups_owner_user_id_fkey";
ALTER TABLE "duplicate_groups" ADD CONSTRAINT "duplicate_groups_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "duplicate_groups_owner_group_id_idx" ON "duplicate_groups"("owner_group_id");
CREATE INDEX IF NOT EXISTS "duplicate_groups_owner_user_id_idx" ON "duplicate_groups"("owner_user_id");
ALTER TABLE "duplicate_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "duplicate_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "duplicate_groups_org_isolation" ON "duplicate_groups";
CREATE POLICY "duplicate_groups_org_isolation" ON "duplicate_groups"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- location_suggestions
ALTER TABLE "location_suggestions" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "location_suggestions" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "location_suggestions" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of location_suggestions have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "location_suggestions" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "location_suggestions" DROP CONSTRAINT IF EXISTS "location_suggestions_one_owner_check";
ALTER TABLE "location_suggestions" ADD CONSTRAINT "location_suggestions_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "location_suggestions" DROP CONSTRAINT IF EXISTS "location_suggestions_org_id_fkey";
ALTER TABLE "location_suggestions" ADD CONSTRAINT "location_suggestions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "location_suggestions" DROP CONSTRAINT IF EXISTS "location_suggestions_owner_group_id_org_id_fkey";
ALTER TABLE "location_suggestions" ADD CONSTRAINT "location_suggestions_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "location_suggestions" DROP CONSTRAINT IF EXISTS "location_suggestions_owner_user_id_fkey";
ALTER TABLE "location_suggestions" ADD CONSTRAINT "location_suggestions_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "location_suggestions_owner_group_id_idx" ON "location_suggestions"("owner_group_id");
CREATE INDEX IF NOT EXISTS "location_suggestions_owner_user_id_idx" ON "location_suggestions"("owner_user_id");
ALTER TABLE "location_suggestions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_suggestions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "location_suggestions_org_isolation" ON "location_suggestions";
CREATE POLICY "location_suggestions_org_isolation" ON "location_suggestions"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- media_enhancements
ALTER TABLE "media_enhancements" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "media_enhancements" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_enhancements" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_enhancements have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_enhancements" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_enhancements" DROP CONSTRAINT IF EXISTS "media_enhancements_one_owner_check";
ALTER TABLE "media_enhancements" ADD CONSTRAINT "media_enhancements_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_enhancements" DROP CONSTRAINT IF EXISTS "media_enhancements_org_id_fkey";
ALTER TABLE "media_enhancements" ADD CONSTRAINT "media_enhancements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_enhancements" DROP CONSTRAINT IF EXISTS "media_enhancements_owner_group_id_org_id_fkey";
ALTER TABLE "media_enhancements" ADD CONSTRAINT "media_enhancements_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_enhancements" DROP CONSTRAINT IF EXISTS "media_enhancements_owner_user_id_fkey";
ALTER TABLE "media_enhancements" ADD CONSTRAINT "media_enhancements_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_enhancements_owner_group_id_idx" ON "media_enhancements"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_enhancements_owner_user_id_idx" ON "media_enhancements"("owner_user_id");
ALTER TABLE "media_enhancements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_enhancements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_enhancements_org_isolation" ON "media_enhancements";
CREATE POLICY "media_enhancements_org_isolation" ON "media_enhancements"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- media_enhancement_batches
ALTER TABLE "media_enhancement_batches" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "media_enhancement_batches" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_enhancement_batches" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_enhancement_batches have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_enhancement_batches" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_enhancement_batches" DROP CONSTRAINT IF EXISTS "media_enhancement_batches_one_owner_check";
ALTER TABLE "media_enhancement_batches" ADD CONSTRAINT "media_enhancement_batches_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_enhancement_batches" DROP CONSTRAINT IF EXISTS "media_enhancement_batches_org_id_fkey";
ALTER TABLE "media_enhancement_batches" ADD CONSTRAINT "media_enhancement_batches_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_enhancement_batches" DROP CONSTRAINT IF EXISTS "media_enhancement_batches_owner_group_id_org_id_fkey";
ALTER TABLE "media_enhancement_batches" ADD CONSTRAINT "media_enhancement_batches_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_enhancement_batches" DROP CONSTRAINT IF EXISTS "media_enhancement_batches_owner_user_id_fkey";
ALTER TABLE "media_enhancement_batches" ADD CONSTRAINT "media_enhancement_batches_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_enhancement_batches_owner_group_id_idx" ON "media_enhancement_batches"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_enhancement_batches_owner_user_id_idx" ON "media_enhancement_batches"("owner_user_id");
ALTER TABLE "media_enhancement_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_enhancement_batches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_enhancement_batches_org_isolation" ON "media_enhancement_batches";
CREATE POLICY "media_enhancement_batches_org_isolation" ON "media_enhancement_batches"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- review_runs
ALTER TABLE "review_runs" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "review_runs" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "review_runs" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of review_runs have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "review_runs" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "review_runs" DROP CONSTRAINT IF EXISTS "review_runs_one_owner_check";
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "review_runs" DROP CONSTRAINT IF EXISTS "review_runs_org_id_fkey";
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_runs" DROP CONSTRAINT IF EXISTS "review_runs_owner_group_id_org_id_fkey";
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_runs" DROP CONSTRAINT IF EXISTS "review_runs_owner_user_id_fkey";
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "review_runs_owner_group_id_idx" ON "review_runs"("owner_group_id");
CREATE INDEX IF NOT EXISTS "review_runs_owner_user_id_idx" ON "review_runs"("owner_user_id");
ALTER TABLE "review_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "review_runs_org_isolation" ON "review_runs";
CREATE POLICY "review_runs_org_isolation" ON "review_runs"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- trash_empty_runs
ALTER TABLE "trash_empty_runs" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "trash_empty_runs" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "trash_empty_runs" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of trash_empty_runs have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "trash_empty_runs" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "trash_empty_runs" DROP CONSTRAINT IF EXISTS "trash_empty_runs_one_owner_check";
ALTER TABLE "trash_empty_runs" ADD CONSTRAINT "trash_empty_runs_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "trash_empty_runs" DROP CONSTRAINT IF EXISTS "trash_empty_runs_org_id_fkey";
ALTER TABLE "trash_empty_runs" ADD CONSTRAINT "trash_empty_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trash_empty_runs" DROP CONSTRAINT IF EXISTS "trash_empty_runs_owner_group_id_org_id_fkey";
ALTER TABLE "trash_empty_runs" ADD CONSTRAINT "trash_empty_runs_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trash_empty_runs" DROP CONSTRAINT IF EXISTS "trash_empty_runs_owner_user_id_fkey";
ALTER TABLE "trash_empty_runs" ADD CONSTRAINT "trash_empty_runs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "trash_empty_runs_owner_group_id_idx" ON "trash_empty_runs"("owner_group_id");
CREATE INDEX IF NOT EXISTS "trash_empty_runs_owner_user_id_idx" ON "trash_empty_runs"("owner_user_id");
ALTER TABLE "trash_empty_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trash_empty_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trash_empty_runs_org_isolation" ON "trash_empty_runs";
CREATE POLICY "trash_empty_runs_org_isolation" ON "trash_empty_runs"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- workflows
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "workflows" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "workflows" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of workflows have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "workflows" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_one_owner_check";
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_org_id_fkey";
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_owner_group_id_org_id_fkey";
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_owner_user_id_fkey";
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "workflows_owner_group_id_idx" ON "workflows"("owner_group_id");
CREATE INDEX IF NOT EXISTS "workflows_owner_user_id_idx" ON "workflows"("owner_user_id");
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflows" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflows_org_isolation" ON "workflows";
CREATE POLICY "workflows_org_isolation" ON "workflows"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- workflow_runs
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
UPDATE "workflow_runs" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "workflow_runs" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of workflow_runs have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "workflow_runs" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_one_owner_check";
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_org_id_fkey";
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_owner_group_id_org_id_fkey";
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_owner_user_id_fkey";
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "workflow_runs_owner_group_id_idx" ON "workflow_runs"("owner_group_id");
CREATE INDEX IF NOT EXISTS "workflow_runs_owner_user_id_idx" ON "workflow_runs"("owner_user_id");
ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflow_runs_org_isolation" ON "workflow_runs";
CREATE POLICY "workflow_runs_org_isolation" ON "workflow_runs"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- media_visual_embedding
ALTER TABLE "media_visual_embedding" ADD COLUMN IF NOT EXISTS "org_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_group_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_user_id" UUID;
-- Rebuilt below, after the backfill; only when there is something to backfill (a replay keeps them).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "media_visual_embedding" WHERE "org_id" IS NULL) THEN
    DROP INDEX IF EXISTS "media_visual_embedding_hnsw_idx";
  END IF;
END $$;
UPDATE "media_visual_embedding" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "circles" c
WHERE c."id" = t."circle_id" AND t."org_id" IS NULL;
-- No foreign key on media_visual_embedding.circle_id: a row whose circle is gone takes its media item's.
UPDATE "media_visual_embedding" t
SET "org_id" = mh_default_org_id(),
    "owner_group_id" = CASE WHEN c."is_personal" THEN NULL ELSE c."id" END,
    "owner_user_id" = CASE WHEN c."is_personal" THEN c."owner_id" ELSE NULL END
FROM "media_items" mi JOIN "circles" c ON c."id" = mi."circle_id"
WHERE mi."id" = t."media_item_id" AND t."org_id" IS NULL;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "media_visual_embedding" WHERE "org_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-I2: % row(s) of media_visual_embedding have no circle to take an owner from (see scripts/circles-to-groups/dry-run.mjs)', n;
  END IF;
END $$;
ALTER TABLE "media_visual_embedding" ALTER COLUMN "org_id" SET DEFAULT mh_default_org_id(),
  ALTER COLUMN "org_id" SET NOT NULL;
ALTER TABLE "media_visual_embedding" DROP CONSTRAINT IF EXISTS "media_visual_embedding_one_owner_check";
ALTER TABLE "media_visual_embedding" ADD CONSTRAINT "media_visual_embedding_one_owner_check" CHECK (num_nonnulls("owner_user_id", "owner_group_id") = 1);
ALTER TABLE "media_visual_embedding" DROP CONSTRAINT IF EXISTS "media_visual_embedding_org_id_fkey";
ALTER TABLE "media_visual_embedding" ADD CONSTRAINT "media_visual_embedding_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_visual_embedding" DROP CONSTRAINT IF EXISTS "media_visual_embedding_owner_group_id_org_id_fkey";
ALTER TABLE "media_visual_embedding" ADD CONSTRAINT "media_visual_embedding_owner_group_id_org_id_fkey" FOREIGN KEY ("owner_group_id", "org_id") REFERENCES "groups"("id", "org_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_visual_embedding" DROP CONSTRAINT IF EXISTS "media_visual_embedding_owner_user_id_fkey";
ALTER TABLE "media_visual_embedding" ADD CONSTRAINT "media_visual_embedding_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "media_visual_embedding_owner_group_id_idx" ON "media_visual_embedding"("owner_group_id");
CREATE INDEX IF NOT EXISTS "media_visual_embedding_owner_user_id_idx" ON "media_visual_embedding"("owner_user_id");
CREATE INDEX IF NOT EXISTS "media_visual_embedding_hnsw_idx" ON "media_visual_embedding" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
ALTER TABLE "media_visual_embedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_visual_embedding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "media_visual_embedding_org_isolation" ON "media_visual_embedding";
CREATE POLICY "media_visual_embedding_org_isolation" ON "media_visual_embedding"
  USING      ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
              OR current_setting('app.rls_bypass', true) = 'on');

-- ---------------------------------------------------------------------------
-- 3. PLATFORM-ADOPTION-SHIM(#573): keep groups and ownership equal to circles
-- ---------------------------------------------------------------------------

-- Content: the owner follows circle_id (insert, and move_to_circle's update).
CREATE OR REPLACE FUNCTION mh_content_owner_from_circle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  personal boolean;
  owner uuid;
BEGIN
  SELECT c."is_personal", c."owner_id" INTO personal, owner FROM "circles" c WHERE c."id" = NEW."circle_id";
  IF NOT FOUND THEN
    -- No circle: the circle foreign key (or the one-owner CHECK) refuses the row.
    RETURN NEW;
  END IF;
  NEW."org_id" := COALESCE(NEW."org_id", mh_default_org_id());
  IF personal THEN
    NEW."owner_user_id" := owner;
    NEW."owner_group_id" := NULL;
  ELSE
    NEW."owner_group_id" := NEW."circle_id";
    NEW."owner_user_id" := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_items";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_items"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "albums";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "albums"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "tags";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "tags"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "people";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "people"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "faces";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "faces"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "memories";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "memories"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_item_embedding";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_item_embedding"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_geocode_status";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_geocode_status"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_metadata_status";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_metadata_status"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_tag_status";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_tag_status"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_transcripts";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_transcripts"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "burst_groups";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "burst_groups"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "duplicate_groups";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "duplicate_groups"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "location_suggestions";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "location_suggestions"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_enhancements";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_enhancements"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_enhancement_batches";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_enhancement_batches"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "review_runs";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "review_runs"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "trash_empty_runs";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "trash_empty_runs"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "workflows";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "workflows"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "workflow_runs";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "workflow_runs"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();
DROP TRIGGER IF EXISTS "mh_owner_from_circle" ON "media_visual_embedding";
CREATE TRIGGER "mh_owner_from_circle" BEFORE INSERT OR UPDATE OF "circle_id" ON "media_visual_embedding"
  FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_circle();

-- Circles -> groups. Writes the FORCE RLS tables under a transaction-local
-- bypass it restores before returning (an error rolls the setting back with the
-- statement). A personal circle has no group; a circle never changes kind.
CREATE OR REPLACE FUNCTION mh_circle_mirror_group() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  prev text := current_setting('app.rls_bypass', true);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."is_personal" IS DISTINCT FROM OLD."is_personal" THEN
    RAISE EXCEPTION 'RETRO-I2: circle % cannot change is_personal (its content ownership would diverge)', NEW."id";
  END IF;
  PERFORM set_config('app.rls_bypass', 'on', true);
  IF TG_OP = 'INSERT' AND NOT NEW."is_personal" THEN
    INSERT INTO "groups" ("id", "org_id", "name", "description", "created_by_id", "version", "created_at", "updated_at")
    VALUES (NEW."id", mh_default_org_id(), NEW."name", NEW."description", NEW."owner_id", 1, NEW."created_at", NEW."updated_at")
    ON CONFLICT ("id") DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND NOT NEW."is_personal"
        AND (NEW."name", NEW."description") IS DISTINCT FROM (OLD."name", OLD."description") THEN
    UPDATE "groups" SET "name" = NEW."name", "description" = NEW."description",
                        "version" = "version" + 1, "updated_at" = now()
    WHERE "id" = NEW."id";
  ELSIF TG_OP = 'DELETE' AND NOT OLD."is_personal" THEN
    DELETE FROM "groups" WHERE "id" = OLD."id";
  END IF;
  PERFORM set_config('app.rls_bypass', COALESCE(prev, ''), true);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "mh_circle_mirror_group" ON "circles";
CREATE TRIGGER "mh_circle_mirror_group" AFTER INSERT OR UPDATE OR DELETE ON "circles"
  FOR EACH ROW EXECUTE FUNCTION mh_circle_mirror_group();

-- Circle members -> group members (non-personal circles only).
CREATE OR REPLACE FUNCTION mh_circle_member_mirror() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  prev text := current_setting('app.rls_bypass', true);
BEGIN
  PERFORM set_config('app.rls_bypass', 'on', true);
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (NEW."circle_id", NEW."user_id") IS DISTINCT FROM (OLD."circle_id", OLD."user_id")) THEN
    DELETE FROM "group_members" WHERE "group_id" = OLD."circle_id" AND "user_id" = OLD."user_id";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO "group_members" ("id", "group_id", "user_id", "org_id", "role", "created_at", "updated_at")
    SELECT gen_random_uuid(), g."id", NEW."user_id", g."org_id", mh_circle_role_to_group_role(NEW."role"::text), NEW."created_at", now()
    FROM "groups" g JOIN "circles" c ON c."id" = g."id" AND NOT c."is_personal"
    WHERE g."id" = NEW."circle_id"
    ON CONFLICT ("group_id", "user_id") DO UPDATE SET "role" = EXCLUDED."role", "updated_at" = now();
  END IF;
  PERFORM set_config('app.rls_bypass', COALESCE(prev, ''), true);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "mh_circle_member_mirror" ON "circle_members";
CREATE TRIGGER "mh_circle_member_mirror" AFTER INSERT OR UPDATE OR DELETE ON "circle_members"
  FOR EACH ROW EXECUTE FUNCTION mh_circle_member_mirror();

-- A group that mirrors a circle is deleted with the circle, never on its own
-- (DELETE /api/groups/:id of an empty mirrored group would orphan the circle's
-- next upload: its owner_group_id would name no group).
CREATE OR REPLACE FUNCTION mh_group_mirror_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "circles" WHERE "id" = OLD."id") THEN
    RAISE EXCEPTION 'RETRO-I2: group % mirrors a circle; delete the circle instead', OLD."id";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "mh_group_mirror_guard" ON "groups";
CREATE TRIGGER "mh_group_mirror_guard" BEFORE DELETE ON "groups"
  FOR EACH ROW EXECUTE FUNCTION mh_group_mirror_guard();

COMMIT;
