-- Public Media Sharing migration: add ShareTargetType enum and media_shares table.
--
-- media_shares allows a user to publicly share either a single MediaItem or an
-- entire Album via an opaque token, with optional expiration and soft-revoke.
--
-- A CHECK constraint (media_shares_target_xor) enforces the XOR invariant:
--   - When target_type = 'media_item', media_item_id must be non-null and album_id must be null.
--   - When target_type = 'album', album_id must be non-null and media_item_id must be null.
--
-- This constraint cannot be expressed in Prisma schema, so it is added via raw SQL here.

-- -----------------------------------------------------------------------------
-- Enum
-- -----------------------------------------------------------------------------

CREATE TYPE "ShareTargetType" AS ENUM ('media_item', 'album');

-- -----------------------------------------------------------------------------
-- Table: media_shares
-- -----------------------------------------------------------------------------

CREATE TABLE "media_shares" (
    "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
    "token"         TEXT        NOT NULL,
    "target_type"   "ShareTargetType" NOT NULL,
    "media_item_id" UUID,
    "album_id"      UUID,
    "circle_id"     UUID        NOT NULL,
    "created_by_id" UUID        NOT NULL,
    "expires_at"    TIMESTAMPTZ,
    "revoked_at"    TIMESTAMPTZ,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "media_shares_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_shares_token_key" UNIQUE ("token"),
    CONSTRAINT "media_shares_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE,
    CONSTRAINT "media_shares_album_id_fkey"
        FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE,
    CONSTRAINT "media_shares_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "media_shares_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- XOR invariant: exactly one of media_item_id / album_id must be set,
-- consistent with the target_type discriminator.
ALTER TABLE "media_shares" ADD CONSTRAINT "media_shares_target_xor"
    CHECK (
        (target_type = 'media_item' AND media_item_id IS NOT NULL AND album_id IS NULL)
        OR
        (target_type = 'album' AND album_id IS NOT NULL AND media_item_id IS NULL)
    );

-- Indexes
CREATE INDEX "media_shares_circle_id_idx"     ON "media_shares" ("circle_id");
CREATE INDEX "media_shares_created_by_id_idx" ON "media_shares" ("created_by_id");
CREATE INDEX "media_shares_media_item_id_idx" ON "media_shares" ("media_item_id");
CREATE INDEX "media_shares_album_id_idx"      ON "media_shares" ("album_id");
