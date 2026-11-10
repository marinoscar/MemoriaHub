-- RETRO-K2 (#588, #583, #573): drop circles, circle_members and the CircleRole enum.
--
-- After RETRO-I2 every shared circle IS a platform group of the same id, and after RETRO-K1 no
-- code reads or writes `circles` / `circle_members`. What the two tables still did:
--
--   1. every content table's `circle_id` had a foreign key to `circles`;
--   2. the personal circles were the only place the id of a user's personal library lived;
--   3. the RETRO-I2 triggers mirrored `circles` / `circle_members` into `groups` / `group_members`
--      and derived each content row's owner columns from `circle_id`.
--
-- This migration keeps `circle_id` as the library's SCOPE ID (a group's id, or the id of a
-- personal library), without a foreign key, and changes nothing else about a content row:
--
--   * `personal_libraries (id, user_id UNIQUE)` gets one row per personal circle, with the SAME
--     id, so no content row's `circle_id` changes (checked below: row counts and owner columns of
--     all 21 content tables are compared before and after, the migration aborts on any difference);
--   * `mh_content_owner_from_scope()` replaces `mh_content_owner_from_circle()` on the same 21
--     tables (`mh_owner_from_scope`): it derives `owner_group_id` (the id is a group) or
--     `owner_user_id` (the id is a personal library) and REFUSES a row whose `circle_id` is neither
--     (SQLSTATE 23503), which is what the dropped foreign key guaranteed;
--   * the foreign keys to `circles`, the mirror triggers and functions, the two tables and the
--     enum go.
--
-- ONE-WAY. Rolling back means restoring the backup taken before the upgrade (docs/runbooks/
-- circles-to-groups.md §9). Idempotent where cheap (IF EXISTS); the verification below runs first.

BEGIN;
SELECT set_config('app.rls_bypass', 'on', true);

-- ---------------------------------------------------------------------------
-- 0. Preconditions: refuse before changing anything
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  n bigint;
  t text;
  content_tables text[] := ARRAY[
    'media_items', 'media_item_embedding', 'albums', 'tags', 'people', 'faces', 'memories', 'burst_groups',
    'duplicate_groups', 'location_suggestions', 'media_enhancements', 'media_enhancement_batches',
    'media_metadata_status', 'media_geocode_status', 'media_tag_status', 'media_transcripts', 'review_runs',
    'trash_empty_runs', 'workflows', 'workflow_runs', 'media_visual_embedding'
  ];
BEGIN
  IF to_regclass('public.circles') IS NULL THEN
    RETURN; -- already applied (the statements below are all IF EXISTS)
  END IF;

  SELECT count(*) INTO n FROM (SELECT owner_id FROM circles WHERE is_personal GROUP BY owner_id HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-K2: % user(s) have more than one personal circle; merge them first (their content would lose its scope id)', n;
  END IF;

  SELECT count(*) INTO n FROM circles c WHERE NOT c.is_personal AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = c.id);
  IF n > 0 THEN
    RAISE EXCEPTION 'RETRO-K2: % shared circle(s) have no group of the same id (RETRO-I2 mirror out of step)', n;
  END IF;

  FOREACH t IN ARRAY content_tables LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I x WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = x.circle_id) AND NOT EXISTS (SELECT 1 FROM circles c WHERE c.id = x.circle_id AND c.is_personal)',
      t) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'RETRO-K2: % row(s) of % name a scope that is neither a group nor a personal circle', n, t;
    END IF;
  END LOOP;
END $$;

-- A fingerprint of every content table before: row count and a hash of the ordered (circle_id, org_id, owner_group_id, owner_user_id) tuples.
CREATE TEMP TABLE _k2_before (tbl text PRIMARY KEY, n bigint NOT NULL, fp text NOT NULL) ON COMMIT DROP;
DO $$
DECLARE
  t text;
  content_tables text[] := ARRAY[
    'media_items', 'media_item_embedding', 'albums', 'tags', 'people', 'faces', 'memories', 'burst_groups',
    'duplicate_groups', 'location_suggestions', 'media_enhancements', 'media_enhancement_batches',
    'media_metadata_status', 'media_geocode_status', 'media_tag_status', 'media_transcripts', 'review_runs',
    'trash_empty_runs', 'workflows', 'workflow_runs', 'media_visual_embedding'
  ];
BEGIN
  IF to_regclass('public.circles') IS NULL THEN RETURN; END IF;
  FOREACH t IN ARRAY content_tables LOOP
    EXECUTE format(
      'INSERT INTO _k2_before SELECT %L, count(*), COALESCE(md5(string_agg(concat_ws(''|'', circle_id, org_id, owner_group_id, owner_user_id), '','' ORDER BY concat_ws(''|'', circle_id, org_id, owner_group_id, owner_user_id))), '''') FROM %I',
      t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Personal libraries: the personal circles' ids, kept
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "personal_libraries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "personal_libraries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "personal_libraries_user_id_key" ON "personal_libraries"("user_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'personal_libraries_user_id_fkey') THEN
    ALTER TABLE "personal_libraries"
      ADD CONSTRAINT "personal_libraries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.circles') IS NOT NULL THEN
    INSERT INTO "personal_libraries" ("id", "user_id", "created_at")
    SELECT c."id", c."owner_id", c."created_at" FROM "circles" c WHERE c."is_personal"
    ON CONFLICT ("id") DO NOTHING;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The owner columns follow the scope id (replaces mh_content_owner_from_circle)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mh_content_owner_from_scope() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  owner uuid;
BEGIN
  NEW."org_id" := COALESCE(NEW."org_id", mh_default_org_id());
  IF EXISTS (SELECT 1 FROM "groups" g WHERE g."id" = NEW."circle_id") THEN
    NEW."owner_group_id" := NEW."circle_id";
    NEW."owner_user_id" := NULL;
  ELSE
    SELECT p."user_id" INTO owner FROM "personal_libraries" p WHERE p."id" = NEW."circle_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RETRO-K2: scope % is neither a group nor a personal library', NEW."circle_id"
        USING ERRCODE = '23503';
    END IF;
    NEW."owner_user_id" := owner;
    NEW."owner_group_id" := NULL;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'mh_owner_from_circle' AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER "mh_owner_from_circle" ON %I', r.tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS "mh_owner_from_scope" ON %I', r.tbl);
    EXECUTE format(
      'CREATE TRIGGER "mh_owner_from_scope" BEFORE INSERT OR UPDATE OF "circle_id" ON %I FOR EACH ROW EXECUTE FUNCTION mh_content_owner_from_scope()',
      r.tbl);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Drop the mirror, the foreign keys, the tables and the enum
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS "mh_group_mirror_guard" ON "groups";
DO $$
BEGIN
  IF to_regclass('public.circles') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS "mh_circle_mirror_group" ON "circles";
    DROP TRIGGER IF EXISTS "mh_circle_member_mirror" ON "circle_members";
  END IF;
END $$;

-- Every foreign key that names `circles` except those of `circle_members` (which goes with its table).
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.circles') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'public.circles'::regclass AND conrelid <> 'public.circle_members'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

DROP TABLE IF EXISTS "circle_members";
DROP TABLE IF EXISTS "circles";
DROP TYPE IF EXISTS "CircleRole";

DROP FUNCTION IF EXISTS mh_circle_mirror_group();
DROP FUNCTION IF EXISTS mh_circle_member_mirror();
DROP FUNCTION IF EXISTS mh_group_mirror_guard();
DROP FUNCTION IF EXISTS mh_content_owner_from_circle();
DROP FUNCTION IF EXISTS mh_circle_role_to_group_role(text);

-- ---------------------------------------------------------------------------
-- 4. Proof: nothing about any content row changed
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
  after_n bigint;
  after_fp text;
BEGIN
  FOR r IN SELECT b.tbl, b.n AS before_n, b.fp AS before_fp FROM _k2_before b LOOP
    EXECUTE format(
      'SELECT count(*), COALESCE(md5(string_agg(concat_ws(''|'', circle_id, org_id, owner_group_id, owner_user_id), '','' ORDER BY concat_ws(''|'', circle_id, org_id, owner_group_id, owner_user_id))), '''') FROM %I',
      r.tbl) INTO after_n, after_fp;
    IF after_n <> r.before_n OR after_fp <> r.before_fp THEN
      RAISE EXCEPTION 'RETRO-K2: table % changed (rows % -> %, owner fingerprint % -> %)', r.tbl, r.before_n, after_n, r.before_fp, after_fp;
    END IF;
  END LOOP;
END $$;

COMMIT;
