/**
 * test/job-insights.spec.ts: `normalizeJobInsights` keeps `memoriahub jobs insights` and the TUI
 * working against the platform queue's answer (RETRO-C1, #575).
 */

import { normalizeJobInsights, type JobInsights, type PlatformJobInsights } from '../src/api.js';

const HISTORY: JobInsights['history'] = {
  overall: { samples: 10, avgMs: 100, p50Ms: 90, p95Ms: 300, throughputPerMin: 4 },
  byType: [],
};

function platform(eta: PlatformJobInsights['eta']): PlatformJobInsights {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    windowDays: 7,
    concurrency: 2,
    live: {
      total: 10,
      byStatus: { pending: 6, running: 2, succeeded: 1, failed: 1 },
      scheduled: 1,
      rateLimited: 0,
      retried: 3,
      byType: [{ type: 'face_detection', pending: 6, running: 2, succeeded: 1, failed: 1, total: 10 }],
    },
    history: HISTORY,
    eta,
  };
}

describe('normalizeJobInsights', () => {
  it('returns the pre-cutover answer unchanged', () => {
    const legacy = { computedAt: 'x', eta: { totalRemaining: 1, etaMs: 2, basis: 'live', perType: [] } } as unknown as JobInsights;
    expect(normalizeJobInsights(legacy)).toBe(legacy);
  });

  it('maps generatedAt to computedAt and lifts the status counts the CLI reads', () => {
    const result = normalizeJobInsights(platform([]));
    expect(result.computedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.live).toMatchObject({ pending: 6, running: 2, failed: 1, scheduled: 1, retried: 3 });
    expect(result.history).toBe(HISTORY);
  });

  it('turns the per-type eta array into the total, the sum of the estimates, and the per-type rows', () => {
    const result = normalizeJobInsights(
      platform([
        { type: 'face_detection', remaining: 8, avgMs: 100, basis: 'live', estimatedMs: 400 },
        { type: 'auto_tagging', remaining: 2, avgMs: 50, basis: 'partial', estimatedMs: 50 },
      ]),
    );
    expect(result.eta).toEqual({
      totalRemaining: 10,
      etaMs: 450,
      basis: 'partial',
      perType: [
        { type: 'face_detection', remaining: 8, avgMs: 100, etcMs: 400 },
        { type: 'auto_tagging', remaining: 2, avgMs: 50, etcMs: 50 },
      ],
    });
  });

  it('has no ETA when a type with work outstanding has no measurement', () => {
    const result = normalizeJobInsights(
      platform([{ type: 'geocode', remaining: 3, avgMs: 0, basis: 'none', estimatedMs: 0 }]),
    );
    expect(result.eta).toMatchObject({ totalRemaining: 3, etaMs: null, basis: 'none' });
    expect(result.eta.perType[0]).toMatchObject({ avgMs: null, etcMs: null });
  });

  it('an empty queue has an ETA of zero and no basis', () => {
    expect(normalizeJobInsights(platform([])).eta).toEqual({ totalRemaining: 0, etaMs: 0, basis: 'none', perType: [] });
  });
});
