-- Add a partial composite index on media_items to accelerate the Map View's
-- location-aggregation query.
--
-- INTENT: Serves MediaService.aggregateLocations / listLocations (the map view
-- endpoint, GET /api/media/locations), which loads all of the caller's
-- geotagged, non-deleted, non-archived media as a flat array for map display.
-- The query filters on:
--   deleted_at IS NULL
--   AND archived_at IS NULL
--   AND taken_lat IS NOT NULL
--   AND taken_lng IS NOT NULL
--   AND circle_id = $circleId
--   [AND captured_at BETWEEN $capturedAtFrom AND $capturedAtTo]
-- and the map UI further buckets/aggregates results by location and by time
-- range. Without this index the planner must scan every media_items row for
-- the circle (or worse, the whole table) to find the geotagged, non-deleted,
-- non-archived subset before it can even begin aggregating.
--
-- WHY THIS PARTIAL PREDICATE:
--   The partial WHERE clause below mirrors the query's filters exactly
--   (non-deleted, non-archived, geotagged) so the index only contains rows
--   that the map view actually reads — keeping it small relative to the full
--   table (most media items either lack GPS or are excluded by soft-delete /
--   archive state) and avoiding index bloat from rows the query never wants.
--
-- WHY THIS KEY ORDER:
--   (circle_id, captured_at DESC, taken_lat, taken_lng)
--   - circle_id leads because every call is scoped to a single circle.
--   - captured_at DESC next supports the optional capturedAt range filter
--     (aggregateLocations / listLocations accept capturedAtFrom/capturedAtTo)
--     and lets chronological/most-recent-first aggregation use the index
--     order directly instead of a separate sort.
--   - taken_lat, taken_lng trail as included key columns so grid/bucket
--     aggregation over coordinates can be satisfied directly from the index
--     without a heap fetch for the columns it actually aggregates on.
--
-- WHY A HAND-AUTHORED MIGRATION (not schema.prisma):
--   Prisma's schema DSL has no syntax for partial indexes (a WHERE clause on
--   @@index()). Only plain column lists are supported, so this index cannot
--   be expressed via schema.prisma; it must be authored as raw SQL. See the
--   precedent in migration 20260615000000_media_oncethisday_index for the
--   same pattern (functional + partial index, hand-authored).
--
-- DOWN DIRECTION:
--   DROP INDEX "media_items_map_locations_idx";
--
-- SCHEMA DRIFT NOTE:
--   This index is intentionally hand-authored and is NOT fully representable
--   in schema.prisma (only a plain-column annotation comment is added there
--   for discoverability; see the MediaItem model's @@index block). The
--   project uses `prisma migrate deploy` (not `migrate dev`) in all
--   non-local environments, so Prisma never runs a drift-detection step that
--   would error out. In local development `migrate dev` does detect drift;
--   to avoid spurious warnings the developer should NOT run `migrate dev`
--   after this migration is applied without first understanding this
--   intentional gap.

-- CreateIndex (partial, composite)
CREATE INDEX "media_items_map_locations_idx"
  ON "media_items" ("circle_id", "captured_at" DESC, "taken_lat", "taken_lng")
  WHERE "deleted_at" IS NULL
    AND "archived_at" IS NULL
    AND "taken_lat" IS NOT NULL
    AND "taken_lng" IS NOT NULL;
