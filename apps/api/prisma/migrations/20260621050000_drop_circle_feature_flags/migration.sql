-- Drop per-circle feature opt-in columns. These flags have been superseded and
-- no production code references them. Removal keeps the schema lean and avoids
-- stale columns that could cause confusion.

ALTER TABLE "circles" DROP COLUMN "face_recognition_enabled";
ALTER TABLE "circles" DROP COLUMN "auto_tagging_enabled";
ALTER TABLE "circles" DROP COLUMN "burst_detection_enabled";
