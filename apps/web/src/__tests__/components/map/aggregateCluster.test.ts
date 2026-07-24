/**
 * aggregateClusterUtils — pure unit tests (no DOM, no Leaflet needed).
 *
 * Covers the three Leaflet-free helpers backing the imperative
 * AggregateClusterLayer: the count-badge label formatter, the badge-size
 * picker, and the weighted-count summer used to roll up child-marker weights
 * into a cluster's true underlying item total.
 */

import { describe, it, expect } from 'vitest';
import {
  clusterLabel,
  pickBadgeSize,
  sumWeights,
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
