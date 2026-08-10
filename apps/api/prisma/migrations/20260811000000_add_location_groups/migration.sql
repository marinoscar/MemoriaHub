-- Location Grouping, Part 1 (issue #373) — schema foundation only.
--
-- Reverse-geocoding produces raw, ungoverned strings on media_items
-- (geo_country / geo_admin1 / geo_locality) that vary by provider spelling
-- ("NYC" vs "New York City" vs "Manhattan, NY" all describing the same
-- place). This migration adds an admin-curatable grouping layer:
--
--   - location_groups: one canonical group per (level, country_code,
--     normalized_name) — e.g. one "New York City" locality group.
--   - location_group_aliases: raw geocoder strings that resolve to a group,
--     one row per (level, country_code, normalized_value) so a raw value
--     can never resolve ambiguously to more than one group.
--   - media_items gains three geoCanonical* columns (country/admin1/locality)
--     that always hold a display value — the group's canonical_name when a
--     raw value resolves to one, otherwise the raw value verbatim — because
--     the read path that populates them (a Prisma groupBy) cannot express a
--     COALESCE(canonical, raw) projection at query time.
--
-- Both country_code columns are NOT NULL DEFAULT '' rather than nullable:
-- Postgres unique indexes treat every NULL as distinct from every other
-- NULL, so a nullable scope column would silently permit duplicate groups/
-- aliases under the unique constraints below — the same pitfall already
-- documented on memories.subject_key and
-- notifications_review_queue_live_uniq_idx.
--
-- The migration ends with a one-time backfill UPDATE that seeds every
-- pre-existing media_items row's geoCanonical* columns from its raw geo*
-- columns (no groups exist yet, so canonical == raw everywhere on day one).
-- This is what makes the eventual read-path swap onto the canonical columns
-- behavior-neutral for the existing library.

-- CreateEnum
CREATE TYPE "LocationGroupLevel" AS ENUM ('country', 'region', 'locality');

-- AlterTable
ALTER TABLE "media_items" ADD COLUMN "geo_canonical_country" TEXT;
ALTER TABLE "media_items" ADD COLUMN "geo_canonical_admin1" TEXT;
ALTER TABLE "media_items" ADD COLUMN "geo_canonical_locality" TEXT;

-- CreateTable
CREATE TABLE "location_groups" (
    "id" UUID NOT NULL,
    "level" "LocationGroupLevel" NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL DEFAULT '',
    "cover_media_item_id" UUID,
    "center_lat" DOUBLE PRECISION,
    "center_lng" DOUBLE PRECISION,
    "radius_km" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "location_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_group_aliases" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "level" "LocationGroupLevel" NOT NULL,
    "country_code" TEXT NOT NULL DEFAULT '',
    "raw_value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_group_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_items_geo_canonical_country_idx" ON "media_items"("geo_canonical_country");

-- CreateIndex
CREATE INDEX "media_items_geo_canonical_admin1_idx" ON "media_items"("geo_canonical_admin1");

-- CreateIndex
CREATE INDEX "media_items_geo_canonical_locality_idx" ON "media_items"("geo_canonical_locality");

-- CreateIndex
CREATE INDEX "location_groups_level_enabled_idx" ON "location_groups"("level", "enabled");

-- CreateIndex
CREATE INDEX "location_groups_cover_media_item_id_idx" ON "location_groups"("cover_media_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "location_groups_level_country_code_normalized_name_key" ON "location_groups"("level", "country_code", "normalized_name");

-- CreateIndex
CREATE INDEX "location_group_aliases_group_id_idx" ON "location_group_aliases"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "location_group_aliases_level_country_code_normalized_value_key" ON "location_group_aliases"("level", "country_code", "normalized_value");

-- AddForeignKey
ALTER TABLE "location_groups" ADD CONSTRAINT "location_groups_cover_media_item_id_fkey" FOREIGN KEY ("cover_media_item_id") REFERENCES "media_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_groups" ADD CONSTRAINT "location_groups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_group_aliases" ADD CONSTRAINT "location_group_aliases_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "location_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the canonical columns from the raw ones so the invariant holds for every
-- pre-existing row. This is what makes the read-path swap behaviour-neutral on day one.
UPDATE media_items
   SET geo_canonical_country  = geo_country,
       geo_canonical_admin1   = geo_admin1,
       geo_canonical_locality = geo_locality;
