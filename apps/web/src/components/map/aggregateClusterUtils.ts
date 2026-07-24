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
