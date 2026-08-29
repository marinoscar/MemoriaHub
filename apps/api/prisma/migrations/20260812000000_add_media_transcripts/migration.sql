-- Video auto-tagging: speech transcribed from the OPENING SECONDS of a video
-- (epic #452, issue #454). Never the whole track — `lead_seconds` records how
-- much audio was actually transcribed, which makes a later re-run with a
-- larger budget detectable rather than silently mixed with older, shorter rows.
--
-- Deliberately its own table rather than a column on `media_tag_status`: that
-- is a status table wiped on every tagging reset, and losing the transcript
-- with a status reset would re-pay the transcription bill.

-- CreateTable
CREATE TABLE "media_transcripts" (
    "id" UUID NOT NULL,
    "media_item_id" UUID NOT NULL,
    "circle_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "lead_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "media_transcripts_pkey" PRIMARY KEY ("id")
);

-- One transcript per media item: a re-run upserts rather than duplicating.
-- CreateIndex
CREATE UNIQUE INDEX "media_transcripts_media_item_id_key" ON "media_transcripts"("media_item_id");

-- CreateIndex
CREATE INDEX "media_transcripts_circle_id_idx" ON "media_transcripts"("circle_id");

-- Both FKs cascade: a transcript is speech recognized from one video in one
-- circle and must not outlive either.
-- AddForeignKey
ALTER TABLE "media_transcripts" ADD CONSTRAINT "media_transcripts_media_item_id_fkey" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_transcripts" ADD CONSTRAINT "media_transcripts_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
