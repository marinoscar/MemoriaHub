-- Add capturedAt to duplicate_groups, mirroring burst_groups.captured_at.
--
-- Stores the earliest member's capturedAt so a future GET /api/media/duplicates
-- endpoint can order the review queue chronologically without an expensive
-- subquery, matching the existing burst_groups pattern.

ALTER TABLE "duplicate_groups"
    ADD COLUMN "captured_at" TIMESTAMPTZ;
