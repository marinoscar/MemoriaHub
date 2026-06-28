-- AlterTable: add hidden_at soft-state column to people, mirroring deleted_at
ALTER TABLE "people" ADD COLUMN "hidden_at" TIMESTAMPTZ;

-- CreateIndex: partial index for the common "active" people filter
-- (not hidden and not soft-deleted); mirrors the convention of
-- people_circle_id_idx but scoped to non-hidden, non-deleted rows.
CREATE INDEX "people_circle_id_hidden_at_idx" ON "people" ("circle_id")
  WHERE "hidden_at" IS NULL AND "deleted_at" IS NULL;
