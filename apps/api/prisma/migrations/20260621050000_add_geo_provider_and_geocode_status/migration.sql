-- CreateTable: geo_provider_credentials
-- Mirrors ai_provider_credentials and face_provider_credentials patterns.
CREATE TABLE "geo_provider_credentials" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_key" TEXT NOT NULL,
    "base_url" TEXT,
    "last4" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "geo_provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable: media_geocode_status
-- Mirrors media_metadata_status; reuses MediaMetadataStatusType enum.
CREATE TABLE "media_geocode_status" (
    "id" UUID NOT NULL,
    "media_item_id" UUID NOT NULL,
    "circle_id" UUID NOT NULL,
    "status" "MediaMetadataStatusType" NOT NULL DEFAULT 'not_processed',
    "processed_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "media_geocode_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: geo_provider_credentials unique provider
CREATE UNIQUE INDEX "geo_provider_credentials_provider_key" ON "geo_provider_credentials"("provider");

-- CreateIndex: media_geocode_status unique media_item_id
CREATE UNIQUE INDEX "media_geocode_status_media_item_id_key" ON "media_geocode_status"("media_item_id");

-- CreateIndex: media_geocode_status circle_id
CREATE INDEX "media_geocode_status_circle_id_idx" ON "media_geocode_status"("circle_id");

-- CreateIndex: media_geocode_status status
CREATE INDEX "media_geocode_status_status_idx" ON "media_geocode_status"("status");

-- AddForeignKey: geo_provider_credentials -> users (updated_by_user_id)
ALTER TABLE "geo_provider_credentials" ADD CONSTRAINT "geo_provider_credentials_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: media_geocode_status -> media_items (media_item_id)
ALTER TABLE "media_geocode_status" ADD CONSTRAINT "media_geocode_status_media_item_id_fkey"
    FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: media_geocode_status -> circles (circle_id)
ALTER TABLE "media_geocode_status" ADD CONSTRAINT "media_geocode_status_circle_id_fkey"
    FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
