/**
 * tui/jobs-dashboard-source.ts — the job-queue monitor as a platform dashboard
 * (RETRO-F4, #582): a pure reducer plus a `pollFeed`, so `useDashboard` drives the
 * screen and nothing outlives it (unmounting aborts the request in flight and
 * clears the timer).
 *
 * Ink-free and framework-light on purpose: the reducer is unit-tested without ink
 * (test/tui/jobs-dashboard-source.spec.ts).
 *
 * `GET /api/admin/jobs/insights` is the whole data source; a failed poll never
 * clears the last good data (the platform source reports it as a connection error
 * and the reducer's data stays), exactly the 1.3 "keep last good data visible".
 */
import {
  DashboardSource,
  pollFeed,
  type DashboardReducer,
} from '@marinoscar/platform-cli/tui';

import type { ApiClient, JobInsights } from '../api.js';

/** What the screen shows besides the connection state. */
export interface JobsDashboardData {
  /** The latest insights, or null before the first successful poll. */
  insights: JobInsights | null;
  /** When `insights` was received (epoch ms), or null. */
  receivedAt: number | null;
}

export type JobsDashboardEvent = JobInsights;

/** Pure reducer: a poll result replaces the insights; the clock is injected for tests. */
export function jobsDashboardReducer(now: () => number = Date.now, seed?: JobsDashboardData): DashboardReducer<JobsDashboardData, JobsDashboardEvent> {
  return {
    initial: () => ({ insights: seed?.insights ?? null, receivedAt: seed?.receivedAt ?? null }),
    hydrate: (state) => state,
    reduce: (_state, insights) => ({ insights, receivedAt: now() }),
    // `pollFeed` emits typed events, never raw frames.
    parseEvent: () => undefined,
  };
}

export interface JobsSourceOptions {
  api: Pick<ApiClient, 'getJobInsights'>;
  windowDays: number;
  intervalMs: number;
  /** Seeds a replacement source (a manual refresh) with the data already on screen. */
  seed?: JobsDashboardData | undefined;
  /** Called when a request starts and when it settles: drives the "updating…" indicator. */
  onFetch?: ((state: 'start' | 'end') => void) | undefined;
  now?: (() => number) | undefined;
}

/** A dashboard source polling the server every `intervalMs`. */
export function createJobsSource(options: JobsSourceOptions): DashboardSource<JobsDashboardData, JobsDashboardEvent> {
  const feed = pollFeed<JobsDashboardEvent>(
    async () => {
      options.onFetch?.('start');
      try {
        return await options.api.getJobInsights(options.windowDays);
      } finally {
        options.onFetch?.('end');
      }
    },
    { intervalMs: options.intervalMs },
  );
  return new DashboardSource(jobsDashboardReducer(options.now, options.seed), feed);
}
