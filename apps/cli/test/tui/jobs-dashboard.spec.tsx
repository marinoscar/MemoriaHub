/**
 * test/tui/jobs-dashboard.spec.tsx  (RETRO-F4, #582)
 *
 * The job-queue monitor on the platform dashboard pattern: the reducer
 * (jobs-dashboard-source.ts) is tested without ink; the screen is rendered over a
 * fake API, checking the first paint, the KPI band, the per-type table, "keep the last
 * good data on a failed poll", `[r]` refreshing now and q / Esc leaving.
 */
import { jest } from '@jest/globals';
import { render, cleanup } from 'ink-testing-library';

import type { JobInsights } from '../../src/api.js';
import { JobsDashboard } from '../../src/tui/JobsDashboard.js';
import { createJobsSource, jobsDashboardReducer } from '../../src/tui/jobs-dashboard-source.js';
import { waitForFrame } from './wait-for.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function insights(pending: number): JobInsights {
  return {
    computedAt: '2026-01-01T00:00:00.000Z',
    windowDays: 7,
    concurrency: 3,
    live: {
      total: pending + 2,
      byStatus: { pending, running: 1, succeeded: 1, failed: 0 },
      pending,
      running: 1,
      failed: 0,
      scheduled: 0,
      rateLimited: 0,
      retried: 0,
      byType: [{ type: 'face_detection', pending, running: 1, succeeded: 1, failed: 0, total: pending + 2 }],
    },
    history: {
      overall: { samples: 4, avgMs: 1200, p50Ms: 1000, p95Ms: 2500, throughputPerMin: 4 },
      byType: [{ type: 'face_detection', samples: 4, avgMs: 1200, p50Ms: 1000, p95Ms: 2500, throughputPerMin: 4 }],
    },
    eta: {
      totalRemaining: pending,
      etaMs: 60000,
      basis: 'live',
      perType: [{ type: 'face_detection', remaining: pending, avgMs: 1200, etcMs: 60000 }],
    },
  };
}

afterEach(() => cleanup());

describe('jobsDashboardReducer', () => {
  it('starts empty and replaces the insights with each poll, stamping when it arrived', () => {
    const reducer = jobsDashboardReducer(() => 1234);
    const first = reducer.reduce(reducer.initial(), insights(5));
    expect(first).toEqual({ insights: insights(5), receivedAt: 1234 });
    expect(reducer.reduce(first, insights(2)).insights?.live.pending).toBe(2);
    expect(reducer.initial()).toEqual({ insights: null, receivedAt: null });
  });

  it('a replacement source can be seeded with the data already on screen', () => {
    const seed = { insights: insights(7), receivedAt: 99 };
    expect(jobsDashboardReducer(() => 1, seed).initial()).toEqual(seed);
  });

  it('never parses a raw frame (a poll feed emits typed events only)', () => {
    expect(jobsDashboardReducer().parseEvent({ any: 'frame' })).toBeUndefined();
  });
});

describe('createJobsSource', () => {
  it('polls the API with the window and reports start / end of each request', async () => {
    const getJobInsights = jest.fn(async (_days?: number) => insights(3));
    const seen: string[] = [];
    const source = createJobsSource({
      api: { getJobInsights },
      windowDays: 7,
      intervalMs: 60_000,
      onFetch: (s) => seen.push(s),
    });
    await source.start();
    expect(getJobInsights).toHaveBeenCalledWith(7);
    expect(seen).toEqual(['start', 'end']);
    expect(source.getState().insights?.live.pending).toBe(3);
    expect(source.getState().connected).toBe(true);
    source.stop();
  });

  it('keeps the last good data and reports the error when a later poll fails', async () => {
    let calls = 0;
    const getJobInsights = jest.fn(async () => {
      calls += 1;
      if (calls > 1) throw new Error('server unreachable');
      return insights(3);
    });
    const source = createJobsSource({ api: { getJobInsights }, windowDays: 7, intervalMs: 5 });
    await source.start();
    await waitForFrame(() => source.getState().error ?? '', (e) => e.includes('server unreachable'));
    expect(source.getState().insights?.live.pending).toBe(3);
    source.stop();
  });
});

describe('JobsDashboard', () => {
  it('shows a loading header, then the KPI band and the per-type table', async () => {
    const api = { getJobInsights: jest.fn(async () => insights(4)) };
    const { lastFrame } = render(<JobsDashboard api={api as never} intervalMs={60_000} windowDays={7} serverUrl="http://server.example.test" />);
    expect(stripAnsi(lastFrame()!)).toContain('Job Queue');
    const plain = stripAnsi(await waitForFrame(lastFrame, (f) => f.includes('By Job Type')));
    expect(plain).toContain('server.example.test');
    expect(plain).toContain('Pending: 4');
    expect(plain).toContain('face_detection');
    expect(plain).toContain('concurrency: 3');
  });

  it('shows the error when the first poll fails, and [r] retries', async () => {
    let fail = true;
    const api = {
      getJobInsights: jest.fn(async () => {
        if (fail) throw new Error('boom');
        return insights(1);
      }),
    };
    const { lastFrame, stdin } = render(<JobsDashboard api={api as never} intervalMs={60_000} windowDays={7} />);
    await waitForFrame(lastFrame, (f) => f.includes('Error: boom'));
    fail = false;
    stdin.write('r');
    await waitForFrame(lastFrame, (f) => f.includes('By Job Type'));
    expect(api.getJobInsights.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('q goes back when mounted as a screen', async () => {
    const onBack = jest.fn();
    const api = { getJobInsights: jest.fn(async () => insights(1)) };
    const { lastFrame, stdin } = render(<JobsDashboard api={api as never} intervalMs={60_000} windowDays={7} onBack={onBack} />);
    await waitForFrame(lastFrame, (f) => f.includes('By Job Type'));
    stdin.write('q');
    await waitForFrame(() => String(onBack.mock.calls.length), (n) => n === '1');
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
