-- Face video detection columns: extend the faces table to support
-- video-frame-level face appearances without creating one row per frame.
--
-- video_timestamp_ms  INTEGER  — representative appearance time (ms into the
--                                video) for this person-cluster; NULL for photos.
-- video_timestamps    INTEGER[] — ALL sampled appearance times (ms) across video
--                                 frames for this person-cluster; empty array for
--                                 photos. Feeds video-scrubber markers in the UI.
-- frame_thumbnail_key TEXT     — storage key of the saved representative frame
--                                JPEG used to crop the face without re-running
--                                ffmpeg; NULL for photos (photos crop from the
--                                media image directly).

-- AlterTable
ALTER TABLE "faces"
    ADD COLUMN "video_timestamp_ms"   INTEGER,
    ADD COLUMN "video_timestamps"     INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    ADD COLUMN "frame_thumbnail_key"  TEXT;
