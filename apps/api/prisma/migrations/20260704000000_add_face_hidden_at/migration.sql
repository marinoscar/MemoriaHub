-- AlterTable: add hidden_at soft-state column to faces, mirroring people.hidden_at
-- (archive an individual face without touching detection/assignment state;
-- permanent delete remains a hard row delete, not a soft delete)
ALTER TABLE "faces" ADD COLUMN "hidden_at" TIMESTAMPTZ;

-- CreateIndex: composite index to serve the archived / live unassigned-faces
-- list queries: { circleId, personId: null, hiddenAt: { not: null } } and
-- the live equivalent { circleId, personId: null, hiddenAt: null }.
CREATE INDEX "faces_circle_id_hidden_at_idx" ON "faces" ("circle_id", "hidden_at");

-- CreateIndex: composite index to serve the archived-people list + badge-count
-- query { circleId, hiddenAt: { not: null } }. Named explicitly to avoid
-- colliding with the pre-existing partial index "people_circle_id_hidden_at_idx"
-- (added in migration 20260628000000_person_hidden_at), which only covers the
-- opposite condition (hidden_at IS NULL AND deleted_at IS NULL, i.e. the
-- "active people" query) and does not serve this archived-list lookup.
CREATE INDEX "people_circle_id_hidden_at_composite_idx" ON "people" ("circle_id", "hidden_at");
