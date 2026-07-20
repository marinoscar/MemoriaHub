/**
 * tui/JobsDashboard.tsx — Ink-based live job queue dashboard.
 *
 * Renders a live-updating TUI showing job queue KPIs, per-type stats,
 * ETA/ETC estimates, and throughput metrics fetched from the server.
 *
 * Keys:
 *   r       — refresh immediately
 *   q / Esc — quit
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';

import type { ApiClient, JobInsights } from '../api.js';
import { formatDuration } from '../format-duration.js';
import { BOX_BORDER } from './theme.js';
import { renderTui } from './raw-mode.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface JobsDashboardProps {
  api: ApiClient;
  intervalMs: number;
  windowDays: number;
  serverUrl?: string;
  /**
   * When provided, q/Esc calls this instead of exiting the whole app. Used when
   * the dashboard is mounted as a screen inside the TUI navigation stack; the
   * standalone `memoriahub jobs` command omits it and keeps exit-on-quit.
   */
  onBack?: () => void;
}

// ---------------------------------------------------------------------------
// renderJobsDashboard — entry point used by the jobs command
// ---------------------------------------------------------------------------

export async function renderJobsDashboard(props: JobsDashboardProps): Promise<void> {
  await renderTui(<JobsDashboard {...props} />);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateType(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// JobsDashboard component
// ---------------------------------------------------------------------------

export function JobsDashboard(props: JobsDashboardProps): React.ReactElement {
  const { api, intervalMs, windowDays, serverUrl, onBack } = props;
  const { exit } = useApp();

  // Main data state
  const [data, setData] = useState<JobInsights | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Seconds-since-last-update display
  const [secondsAgo, setSecondsAgo] = useState<number>(0);
  const lastUpdatedRef = useRef<Date | null>(null);

  // Stable fetch function via ref so we can call it from useInput too
  const doFetchRef = useRef<() => Promise<void>>(async () => { /* placeholder */ });

  const doFetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await api.getJobInsights(windowDays);
      setData(result);
      const now = new Date();
      setLastUpdated(now);
      lastUpdatedRef.current = now;
      setSecondsAgo(0);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Keep last good data visible
    } finally {
      setLoading(false);
    }
  }, [api, windowDays]);

  // Keep ref in sync so useInput can call the latest version
  doFetchRef.current = doFetch;

  // Fetch on mount and on interval
  useEffect(() => {
    void doFetch();
    const timer = setInterval(() => { void doFetch(); }, intervalMs);
    return () => { clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seconds-ago ticker
  useEffect(() => {
    const ticker = setInterval(() => {
      if (lastUpdatedRef.current) {
        const diff = Math.floor((Date.now() - lastUpdatedRef.current.getTime()) / 1000);
        setSecondsAgo(diff);
      }
    }, 1000);
    return () => { clearInterval(ticker); };
  }, []);

  // Key handling
  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) { onBack(); } else { exit(); }
      return;
    }
    if (input === 'r') { void doFetchRef.current(); }
  });

  // -------------------------------------------------------------------------
  // Error-only state (no data yet)
  // -------------------------------------------------------------------------
  if (!data && error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box borderStyle={BOX_BORDER} borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold color="cyan">MemoriaHub — Job Queue</Text>
          {loading && (
            <Text color="cyan">  <Spinner type="dots" /></Text>
          )}
        </Box>
        <Box borderStyle={BOX_BORDER} borderColor="red" paddingX={2} paddingY={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
        <Box paddingX={2}>
          <Text dimColor>[r] retry   [q] quit</Text>
        </Box>
      </Box>
    );
  }

  // -------------------------------------------------------------------------
  // Loading first paint
  // -------------------------------------------------------------------------
  if (!data) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box borderStyle={BOX_BORDER} borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold color="cyan">MemoriaHub — Job Queue</Text>
          <Text color="cyan">  <Spinner type="dots" /></Text>
          <Text dimColor>  Loading…</Text>
        </Box>
      </Box>
    );
  }

  // -------------------------------------------------------------------------
  // Build per-type rows
  // -------------------------------------------------------------------------
  const allTypes = new Set<string>([
    ...data.live.byType.map((t) => t.type),
    ...data.history.byType.map((t) => t.type),
    ...data.eta.perType.map((t) => t.type),
  ]);

  const typeRows = Array.from(allTypes).map((type) => {
    const live = data.live.byType.find((t) => t.type === type) ?? {
      pending: 0, running: 0, succeeded: 0, failed: 0, total: 0,
    };
    const hist = data.history.byType.find((t) => t.type === type) ?? {
      samples: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, throughputPerMin: 0,
    };
    const etaRow = data.eta.perType.find((t) => t.type === type) ?? {
      remaining: 0, avgMs: null, etcMs: null,
    };
    return { type, live, hist, etaRow };
  }).sort((a, b) => (b.live.pending + b.live.running) - (a.live.pending + a.live.running));

  const totalRemaining = data.eta.totalRemaining;

  // -------------------------------------------------------------------------
  // Header info
  // -------------------------------------------------------------------------
  const updatedLabel = loading
    ? 'updating…'
    : lastUpdated !== null
    ? `updated ${secondsAgo}s ago`
    : 'never';

  const serverLabel = serverUrl
    ? (() => { try { return new URL(serverUrl).host; } catch { return serverUrl; } })()
    : 'server';

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <Box flexDirection="column" gap={1}>

      {/* 1. Header */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" paddingX={2} paddingY={0} flexDirection="row">
        <Text bold color="cyan">MemoriaHub — Job Queue</Text>
        <Text dimColor>  {serverLabel}  window: {windowDays}d</Text>
        <Text dimColor>  {updatedLabel}</Text>
        {loading && <Text color="cyan">  <Spinner type="dots" /></Text>}
      </Box>

      {/* 2. KPI band */}
      <Box
        borderStyle={BOX_BORDER}
        borderColor="cyan"
        flexDirection="row"
        paddingX={2}
        paddingY={1}
        gap={2}
      >
        <Text>Pending: <Text color="cyan">{data.live.pending}</Text></Text>
        <Text>Running: <Text color="cyan">{data.live.running}</Text></Text>
        <Text>
          Failed:{' '}
          <Text color={data.live.failed > 0 ? 'red' : 'white'}>{data.live.failed}</Text>
        </Text>
        <Text>
          Rate-lim:{' '}
          <Text color={data.live.rateLimited > 0 ? 'yellow' : 'white'}>{data.live.rateLimited}</Text>
        </Text>
        <Text>
          Sched:{' '}
          <Text color={data.live.scheduled > 0 ? 'yellow' : 'white'}>{data.live.scheduled}</Text>
        </Text>
        <Text>Retried: {data.live.retried}</Text>
        <Text bold>
          ETC:{' '}
          <Text color="cyan">
            {data.eta.etaMs !== null ? formatDuration(data.eta.etaMs) : 'n/a'}
          </Text>
        </Text>
        <Text>Avg: {formatDuration(data.history.overall.avgMs)}</Text>
      </Box>

      {/* 3. Per-type table */}
      <Box
        borderStyle={BOX_BORDER}
        borderColor="cyan"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color="cyan">By Job Type</Text>

        {/* Column headers */}
        <Box flexDirection="row" marginTop={1}>
          <Text bold dimColor>{'Type'.padEnd(18)}</Text>
          <Text bold dimColor>{'Queued'.padEnd(8)}</Text>
          <Text bold dimColor>{'Avg'.padEnd(10)}</Text>
          <Text bold dimColor>{'p95'.padEnd(10)}</Text>
          <Text bold dimColor>{'Thr/min'.padEnd(8)}</Text>
          <Text bold dimColor>{'ETC'.padEnd(12)}</Text>
          <Text bold dimColor>{'Share'.padEnd(8)}</Text>
        </Box>

        {typeRows.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No job types in the selected window.</Text>
          </Box>
        )}

        {typeRows.map(({ type, live, hist, etaRow }) => {
          const queued = live.pending + live.running;
          const remaining = etaRow.remaining ?? 0;
          const share = totalRemaining > 0
            ? Math.round((remaining / totalRemaining) * 100)
            : 0;
          const barFill = Math.round(share / 10);
          const bar = '█'.repeat(barFill) + '░'.repeat(10 - barFill);

          // Color logic
          const hasFailed = live.failed > 0;
          const isActive = queued > 0;

          let rowColor: string | undefined;
          let isDim = false;

          if (isActive && hasFailed) {
            rowColor = 'yellow';
          } else if (isActive) {
            rowColor = 'cyan';
          } else if (hasFailed) {
            rowColor = 'red';
          } else {
            isDim = true;
          }

          const thrDisplay = hist.throughputPerMin > 0
            ? hist.throughputPerMin.toFixed(2)
            : '—';
          const etcDisplay = etaRow.etcMs !== null
            ? formatDuration(etaRow.etcMs)
            : 'n/a';

          return (
            <Box key={type} flexDirection="row">
              <Text color={rowColor} dimColor={isDim}>
                {truncateType(type, 17).padEnd(18)}
              </Text>
              <Text color={rowColor} dimColor={isDim}>
                {String(queued).padEnd(8)}
              </Text>
              <Text color={rowColor} dimColor={isDim}>
                {formatDuration(hist.avgMs).padEnd(10)}
              </Text>
              <Text color={rowColor} dimColor={isDim}>
                {formatDuration(hist.p95Ms).padEnd(10)}
              </Text>
              <Text color={rowColor} dimColor={isDim}>
                {thrDisplay.padEnd(8)}
              </Text>
              <Text color={rowColor} dimColor={isDim}>
                {etcDisplay.padEnd(12)}
              </Text>
              <Text color={rowColor} dimColor={isDim}>
                {String(share).padStart(3)}% {bar}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* 4. Error line (shown alongside data so last good data stays visible) */}
      {error && (
        <Box paddingX={2}>
          <Text color="red">⚠ {error}</Text>
        </Box>
      )}

      {/* 5. Footer */}
      <Box paddingX={2}>
        <Text dimColor>
          [r] refresh now   [q] quit   ·   polling every {intervalMs / 1000}s  ·  concurrency: {data.concurrency}
        </Text>
      </Box>

    </Box>
  );
}
