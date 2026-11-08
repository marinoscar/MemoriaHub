-- RETRO-B2 (issue #611): the profile-picture state moves off the platform's
-- "users" table into an app-owned side table, "user_profiles". "users" gets back
-- to the platform's shape (the deviation memoriahub:users-avatar goes away).
--
-- Only users who changed something get a row (an uploaded or person-derived
-- picture, a stored key, or a person link): no row means the defaults ('oauth',
-- no key, no link), which is what every other user is. "users"."profile_image_url"
-- (a platform column) is untouched: it stays the materialised, resolved avatar URL.
--
-- One transaction (Prisma runs a migration in one): copy before drop, so a failure
-- leaves the four columns in place.

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" UUID NOT NULL,
    "avatar_source" "UserAvatarSource" NOT NULL DEFAULT 'oauth',
    "avatar_storage_key" TEXT,
    "avatar_version" TEXT,
    "linked_person_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "user_profiles_linked_person_id_idx" ON "user_profiles"("linked_person_id");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_linked_person_id_fkey" FOREIGN KEY ("linked_person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Copy: every user whose avatar state differs from the defaults.
INSERT INTO "user_profiles" ("user_id", "avatar_source", "avatar_storage_key", "avatar_version", "linked_person_id", "created_at", "updated_at")
SELECT "id", "avatar_source", "avatar_storage_key", "avatar_version", "linked_person_id", now(), now()
FROM "users"
WHERE "avatar_source" <> 'oauth'
   OR "avatar_storage_key" IS NOT NULL
   OR "avatar_version" IS NOT NULL
   OR "linked_person_id" IS NOT NULL;

-- Contract: the columns, their index and their foreign key leave "users".
ALTER TABLE "users" DROP CONSTRAINT "users_linked_person_id_fkey";
DROP INDEX "users_linked_person_id_idx";
ALTER TABLE "users"
  DROP COLUMN "avatar_source",
  DROP COLUMN "avatar_storage_key",
  DROP COLUMN "avatar_version",
  DROP COLUMN "linked_person_id";
