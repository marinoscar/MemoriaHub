-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('photo', 'video');

-- CreateEnum
CREATE TYPE "MediaSource" AS ENUM ('web', 'cli', 'android', 'import', 'sync');

-- CreateEnum
CREATE TYPE "MediaClassification" AS ENUM ('memory', 'low_value', 'unreviewed');

-- CreateTable
CREATE TABLE "media_items" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "storage_object_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "type" "MediaType" NOT NULL,
    "captured_at" TIMESTAMPTZ,
    "captured_at_offset" INTEGER,
    "imported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "MediaSource" NOT NULL,
    "content_hash" TEXT,
    "classification" "MediaClassification" NOT NULL DEFAULT 'unreviewed',
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "orientation" INTEGER,
    "camera_make" TEXT,
    "camera_model" TEXT,
    "original_filename" TEXT NOT NULL,
    "metadata" JSONB,
    "title" TEXT,
    "caption" TEXT,
    "description" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ,
    "original_created_at" TIMESTAMPTZ,
    "source_path" TEXT,
    "source_device_id" TEXT,
    "source_device_name" TEXT,
    "taken_lat" DOUBLE PRECISION,
    "taken_lng" DOUBLE PRECISION,
    "taken_altitude" DOUBLE PRECISION,
    "geo_country" TEXT,
    "geo_country_code" TEXT,
    "geo_admin1" TEXT,
    "geo_admin2" TEXT,
    "geo_locality" TEXT,
    "geo_place_name" TEXT,
    "geo_source" TEXT,
    "geocoded_at" TIMESTAMPTZ,

    CONSTRAINT "media_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "albums" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "albums_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "album_items" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "album_id" UUID NOT NULL,
    "media_item_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "album_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_tags" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tag_id" UUID NOT NULL,
    "media_item_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_items_storage_object_id_key" ON "media_items"("storage_object_id");

-- CreateIndex
CREATE INDEX "media_items_owner_id_idx" ON "media_items"("owner_id");

-- CreateIndex
CREATE INDEX "media_items_captured_at_idx" ON "media_items"("captured_at");

-- CreateIndex
CREATE INDEX "media_items_content_hash_idx" ON "media_items"("content_hash");

-- CreateIndex
CREATE INDEX "media_items_classification_idx" ON "media_items"("classification");

-- CreateIndex
CREATE INDEX "media_items_type_idx" ON "media_items"("type");

-- CreateIndex
CREATE INDEX "media_items_deleted_at_idx" ON "media_items"("deleted_at");

-- CreateIndex
CREATE INDEX "media_items_favorite_idx" ON "media_items"("favorite");

-- CreateIndex
CREATE INDEX "media_items_geo_country_code_idx" ON "media_items"("geo_country_code");

-- CreateIndex
CREATE INDEX "media_items_geo_admin1_idx" ON "media_items"("geo_admin1");

-- CreateIndex
CREATE INDEX "media_items_geo_locality_idx" ON "media_items"("geo_locality");

-- CreateIndex
CREATE INDEX "albums_owner_id_idx" ON "albums"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "album_items_album_id_media_item_id_key" ON "album_items"("album_id", "media_item_id");

-- CreateIndex
CREATE INDEX "album_items_album_id_idx" ON "album_items"("album_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_owner_id_name_key" ON "tags"("owner_id", "name");

-- CreateIndex
CREATE INDEX "tags_owner_id_idx" ON "tags"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_tags_tag_id_media_item_id_key" ON "media_tags"("tag_id", "media_item_id");

-- CreateIndex
CREATE INDEX "media_tags_media_item_id_idx" ON "media_tags"("media_item_id");

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_storage_object_id_fkey" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "albums" ADD CONSTRAINT "albums_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "album_items" ADD CONSTRAINT "album_items_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "album_items" ADD CONSTRAINT "album_items_media_item_id_fkey" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_media_item_id_fkey" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
