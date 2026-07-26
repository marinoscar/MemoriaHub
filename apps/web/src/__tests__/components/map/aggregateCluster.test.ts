/**
 * aggregateClusterUtils — pure unit tests (no DOM, no Leaflet needed).
 *
 * Covers the Leaflet-free helpers backing the imperative AggregateClusterLayer:
 * the count-badge label formatter, the badge-size picker, the weighted-count
 * summer used to roll up child-marker weights into a cluster's true underlying
 * item total, and (issue #187) the true-footprint bbox/union helpers that
 * replaced the fixed +/-0.001deg epsilon around a cell's centroid.
 */

import { describe, it, expect } from 'vitest';
import {
  bboxFromExtent,
  clusterLabel,
  pickBadgeSize,
  sumWeights,
  unionExtents,
  type ClusterExtent,
} from '../../../components/map/aggregateClusterUtils';

describe('clusterLabel', () => {
  it('returns the exact number for counts under 1000', () => {
    expect(clusterLabel(399)).toBe('399');
    expect(clusterLabel(999)).toBe('999');
  });

  it('returns one-decimal thousands for counts in [1000, 10000)', () => {
    expect(clusterLabel(1200)).toBe('1.2k');
    expect(clusterLabel(3000)).toBe('3k');
    expect(clusterLabel(9999)).toBe('9.9k');
  });

  it('returns whole thousands for counts >= 10000', () => {
    expect(clusterLabel(15000)).toBe('15k');
  });

  it('handles the zero and one boundary as exact numbers', () => {
    expect(clusterLabel(0)).toBe('0');
    expect(clusterLabel(1)).toBe('1');
  });

  it('handles the 1000 boundary as one-decimal thousands', () => {
    expect(clusterLabel(1000)).toBe('1k');
  });

  it('handles the 10000 boundary as whole thousands', () => {
    expect(clusterLabel(10000)).toBe('10k');
  });
});

describe('pickBadgeSize', () => {
  it('returns 28 for counts under 10', () => {
    expect(pickBadgeSize(5)).toBe(28);
  });

  it('returns 34 for counts in [10, 100)', () => {
    expect(pickBadgeSize(50)).toBe(34);
  });

  it('returns 40 for counts in [100, 1000)', () => {
    expect(pickBadgeSize(500)).toBe(40);
  });

  it('returns 44 (hard max) for counts >= 1000, no matter how large', () => {
    expect(pickBadgeSize(5000)).toBe(44);
  });

  it('handles the 9/10 boundary', () => {
    expect(pickBadgeSize(9)).toBe(28);
    expect(pickBadgeSize(10)).toBe(34);
  });

  it('handles the 99/100 boundary', () => {
    expect(pickBadgeSize(99)).toBe(34);
    expect(pickBadgeSize(100)).toBe(40);
  });

  it('handles the 999/1000 boundary', () => {
    expect(pickBadgeSize(999)).toBe(40);
    expect(pickBadgeSize(1000)).toBe(44);
  });
});

describe('sumWeights', () => {
  it('sums an array of finite weights', () => {
    expect(sumWeights([399, 325, 9, 11])).toBe(744);
  });

  it('returns 0 for an empty array', () => {
    expect(sumWeights([])).toBe(0);
  });

  it('treats a NaN entry as a single item (1)', () => {
    expect(sumWeights([NaN, 2])).toBe(3);
  });

  it('treats an Infinity entry as a single item (1)', () => {
    expect(sumWeights([Infinity, 2])).toBe(3);
    expect(sumWeights([-Infinity, 2])).toBe(3);
  });

  it('sums a single-element array', () => {
    expect(sumWeights([7])).toBe(7);
  });
});

describe('bboxFromExtent', () => {
  it('serializes as minLng,minLat,maxLng,maxLat — lng before lat', () => {
    const extent: ClusterExtent = { minLat: 9.9, minLng: -84.1, maxLat: 9.95, maxLng: -84.08 };
    // Getting the lng/lat order wrong here is a silent, high-impact bug: the
    // media APIs parse `bbox` positionally, so a swapped pair would still be
    // four well-formed numbers and would still "work" for a roughly-square
    // area near the equator — just against the wrong axis.
    expect(bboxFromExtent(extent)).toBe('-84.1,9.9,-84.08,9.95');
  });

  it('applies no epsilon padding for a degenerate single-point cell (min === max)', () => {
    const extent: ClusterExtent = { minLat: 9.9, minLng: -84.1, maxLat: 9.9, maxLng: -84.1 };
    expect(bboxFromExtent(extent)).toBe('-84.1,9.9,-84.1,9.9');
  });
});

describe('unionExtents', () => {
  it('returns the single extent unchanged when only one is given', () => {
    const extent: ClusterExtent = { minLat: 9.9, minLng: -84.1, maxLat: 9.95, maxLng: -84.08 };
    expect(unionExtents([extent])).toEqual(extent);
  });

  it('unions multiple overlapping extents to the component-wise min-of-mins / max-of-maxes', () => {
    const a: ClusterExtent = { minLat: 9.9, minLng: -84.1, maxLat: 9.95, maxLng: -84.08 };
    const b: ClusterExtent = { minLat: 9.92, minLng: -84.12, maxLat: 9.97, maxLng: -84.05 };
    expect(unionExtents([a, b])).toEqual({
      minLat: 9.9,
      minLng: -84.12,
      maxLat: 9.97,
      maxLng: -84.05,
    });
  });

  it('unions multiple disjoint extents (e.g. cells from different towns) to their full span', () => {
    const townA: ClusterExtent = { minLat: 9.9, minLng: -84.2, maxLat: 9.92, maxLng: -84.18 };
    const townB: ClusterExtent = { minLat: 10.5, minLng: -85.6, maxLat: 10.52, maxLng: -85.58 };
    expect(unionExtents([townA, townB])).toEqual({
      minLat: 9.9,
      minLng: -85.6,
      maxLat: 10.52,
      maxLng: -84.18,
    });
  });

  it('returns null for an empty array', () => {
    expect(unionExtents([])).toBeNull();
  });
});
