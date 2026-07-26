/**
 * aggregateClusterUtils — pure, Leaflet-free helpers for the aggregate map
 * cluster layer. Kept separate from AggregateClusterLayer.tsx so they can be
 * unit-tested in isolation (parallels clusterUtils.ts).
 */

/**
 * Human-readable count label for a cluster badge.
 *
 * - < 1000  → the exact number (e.g. `42`)
 * - < 10000 → one decimal thousands (e.g. `1.2k`)
 * - else    → whole thousands (e.g. `12k`)
 */
export function clusterLabel(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${Math.floor(count / 100) / 10}k`;
  return `${Math.floor(count / 1000)}k`;
}

/**
 * Badge diameter (px) chosen by magnitude so larger clusters read as larger.
 */
export function pickBadgeSize(count: number): number {
  if (count < 10) return 28;
  if (count < 100) return 34;
  if (count < 1000) return 40;
  return 44;
}

/**
 * Sum an array of per-cell weights, guarding against non-finite values by
 * treating them as a single item (1). Used to aggregate the weighted counts of
 * the child markers inside a markercluster.
 */
export function sumWeights(counts: number[]): number {
  return counts.reduce((sum, c) => sum + (Number.isFinite(c) ? c : 1), 0);
}

/**
 * The true bounding box of an aggregate cell's member points, as returned per
 * cluster by GET /api/media/locations/aggregate.
 */
export interface ClusterExtent {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/**
 * Serialize an extent into the `minLng,minLat,maxLng,maxLat` bbox string the
 * media APIs expect.
 *
 * Deliberately applies NO epsilon padding. The extent is derived server-side
 * from the very rows the bbox will be matched against, and the API filters
 * inclusively (`gte`/`lte`), so the extremal rows match exactly — including the
 * degenerate single-point cell where min === max, which still selects that one
 * point rather than an empty range.
 */
export function bboxFromExtent(extent: ClusterExtent): string {
  const { minLat, minLng, maxLat, maxLng } = extent;
  return `${minLng},${minLat},${maxLng},${maxLat}`;
}

/**
 * Component-wise union of several extents: the min of the mins and the max of
 * the maxes. Used when leaflet.markercluster merges several aggregate cells
 * into one badge — the union of their member-point extents is the real
 * footprint of the merged cluster, whereas the hull of the child MARKER
 * positions is only the hull of their centroids and can omit points sitting up
 * to half a cell outside it.
 *
 * Returns `null` for an empty input so the caller can decide how to degrade
 * (there is no meaningful "empty" bounding box).
 */
export function unionExtents(extents: ClusterExtent[]): ClusterExtent | null {
  if (extents.length === 0) return null;
  return extents.reduce<ClusterExtent>(
    (acc, e) => ({
      minLat: Math.min(acc.minLat, e.minLat),
      minLng: Math.min(acc.minLng, e.minLng),
      maxLat: Math.max(acc.maxLat, e.maxLat),
      maxLng: Math.max(acc.maxLng, e.maxLng),
    }),
    {
      minLat: extents[0].minLat,
      minLng: extents[0].minLng,
      maxLat: extents[0].maxLat,
      maxLng: extents[0].maxLng,
    },
  );
}
