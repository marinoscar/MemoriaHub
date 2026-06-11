/**
 * tui/SyncDashboard.tsx — Live sync dashboard.
 *
 * Constructs ApiClient + repos from passed deps, subscribes to SyncEngine
 * events, and renders:
 *   - StatusLine (header)
 *   - ContextMeter + Legend (headline progress meter)
 *   - ActiveUploads (per-file bars)
 *   - EventLog (rolling log)
 *
 * On run:done transitions to Summary screen.
 * Re-renders are throttled to ~10/s for run:progress events.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type BetterSqlite3 from 'better-sqlite3';

import { SyncEngine } from '../sync/sync-engine.js';
import {
  EV,
  type RunProgressCounts,
  type RunStats,
} from '../sync/events.js';
import { ApiClient } from '../api.js';
import { FolderRepo } from '../repo/folders.js';
import { FileRepo } from '../repo/files.js';
import { RunRepo } from '../repo/runs.js';
import { SettingsRepo } from '../repo/settings.js';
import type { CliConfig } from '../config.js';

import { StatusLine } from './components/StatusLine.js';
import { ContextMeter } from './components/ContextMeter.js';
import { Legend } from './components/Legend.js';
import { ActiveUploads, type ActiveFile } from './components/ActiveUploads.js';
import { EventLog, type LogEvent } from './components/EventLog.js';
import { Summary, type SummaryFailure } from './components/Summary.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncDashboardProps {
  config: CliConfig;
  db: BetterSqlite3.Database;
  all?: boolean;
  folderIds?: number[];
  onHome: () => void;
  /**
   * Optional pre-built engine instance for tests.
   * When provided, the dashboard subscribes to this engine's events
   * instead of constructing its own.  The caller is responsible for
   * calling engine.run() externally.
   */
  _engineForTesting?: SyncEngine;
}

interface DashboardState {
  counts: RunProgressCounts;
  total: number;
  activeFiles: ActiveFile[];
  logEvents: LogEvent[];
  failures: SummaryFailure[];
  isDone: boolean;
  runId: number;
  doneStats: RunStats | null;
  durationMs: number;
  errorMsg: string | null;
}

const EMPTY_COUNTS: RunProgressCounts = {
  queued: 0, uploading: 0, uploaded: 0, skipped: 0, failed: 0,
};

const THROTTLE_MS = 100; // ~10 fps

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncDashboard({
  config,
  db,
  all,
  folderIds,
  onHome,
  _engineForTesting,
}: SyncDashboardProps): React.ReactElement {
  const [state, setState] = useState<DashboardState>({
    counts: EMPTY_COUNTS,
    total: 0,
    activeFiles: [],
    logEvents: [],
    failures: [],
    isDone: false,
    runId: 0,
    doneStats: null,
    durationMs: 0,
    errorMsg: null,
  });

  // Throttle accumulator for run:progress
  const pendingCounts = useRef<RunProgressCounts | null>(null);
  const pendingTotal  = useRef<number>(0);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushProgress = useCallback(() => {
    if (pendingCounts.current === null) return;
    const counts = pendingCounts.current;
    const total  = pendingTotal.current;
    pendingCounts.current = null;
    throttleTimer.current = null;
    setState((prev) => ({ ...prev, counts, total }));
  }, []);

  useInput((_input, key) => {
    if (key.escape || _input === 'q') onHome();
  });

  useEffect(() => {
    // Use an injected engine when testing; otherwise construct one from props.
    let engine: SyncEngine;
    if (_engineForTesting) {
      engine = _engineForTesting;
    } else {
      const api  = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });
      const folders = new FolderRepo(db);
      const files   = new FileRepo(db);
      const runs    = new RunRepo(db);
      const settings = new SettingsRepo(db);
      engine = new SyncEngine({ api, folders, files, runs, settings });
    }

    // run:start
    engine.on(EV.RUN_START, (payload) => {
      setState((prev) => ({
        ...prev,
        runId: payload.runId,
        total: payload.total,
      }));
    });

    // run:progress — throttled
    engine.on(EV.RUN_PROGRESS, (payload) => {
      pendingCounts.current = payload.counts;
      pendingTotal.current  = payload.total;
      if (!throttleTimer.current) {
        throttleTimer.current = setTimeout(flushProgress, THROTTLE_MS);
      }
    });

    // file:start — add to active uploads
    engine.on(EV.FILE_START, (payload) => {
      setState((prev) => ({
        ...prev,
        activeFiles: [
          ...prev.activeFiles.filter((f) => f.fileId !== payload.fileId),
          { fileId: payload.fileId, path: payload.path, fraction: 0 },
        ],
      }));
    });

    // file:progress — update fraction
    engine.on(EV.FILE_PROGRESS, (payload) => {
      setState((prev) => ({
        ...prev,
        activeFiles: prev.activeFiles.map((f) =>
          f.fileId === payload.fileId ? { ...f, fraction: payload.fraction } : f,
        ),
      }));
    });

    // file:done — remove from active, add to log
    engine.on(EV.FILE_DONE, (payload) => {
      const logEv: LogEvent = {
        id: payload.fileId,
        kind: 'done',
        path: payload.path,
      };
      setState((prev) => ({
        ...prev,
        activeFiles: prev.activeFiles.filter((f) => f.fileId !== payload.fileId),
        logEvents:   [...prev.logEvents, logEv],
      }));
    });

    // file:skipped — log it
    engine.on(EV.FILE_SKIPPED, (payload) => {
      const logEv: LogEvent = {
        id: payload.fileId,
        kind: 'skipped',
        path: payload.path,
        reason: payload.reason,
      };
      setState((prev) => ({
        ...prev,
        activeFiles: prev.activeFiles.filter((f) => f.fileId !== payload.fileId),
        logEvents:   [...prev.logEvents, logEv],
      }));
    });

    // file:failed — remove from active, add to log + failures list
    engine.on(EV.FILE_FAILED, (payload) => {
      const logEv: LogEvent = {
        id: payload.fileId,
        kind: 'failed',
        path: payload.path,
        error: payload.error,
        willRetry: payload.willRetry,
      };
      const failure: SummaryFailure = {
        fileId: payload.fileId,
        path: payload.path,
        error: payload.error,
      };
      setState((prev) => ({
        ...prev,
        activeFiles: prev.activeFiles.filter((f) => f.fileId !== payload.fileId),
        logEvents:   [...prev.logEvents, logEv],
        failures:    [...prev.failures, failure],
      }));
    });

    // run:done — flush pending progress, mark done
    engine.on(EV.RUN_DONE, (payload) => {
      // Clear any pending throttle
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
      setState((prev) => ({
        ...prev,
        isDone: true,
        runId: payload.runId,
        doneStats: payload.stats,
        durationMs: payload.durationMs,
        // Update counts from final stats
        counts: {
          queued:    0,
          uploading: 0,
          uploaded:  payload.stats.uploaded,
          skipped:   payload.stats.skipped,
          failed:    payload.stats.failed,
        },
        total: payload.stats.uploaded + payload.stats.skipped + payload.stats.failed,
      }));
    });

    // error
    engine.on(EV.ERROR, (payload) => {
      setState((prev) => ({ ...prev, errorMsg: payload.message, isDone: true }));
    });

    // Kick off the run only when not using an injected test engine.
    // (Test engines have their run() called externally.)
    if (!_engineForTesting) {
      engine.run({
        trigger: 'menu',
        all: all ?? false,
        folderIds: folderIds ?? [],
      }).catch(() => {
        // Fatal errors emitted via EV.ERROR already
      });
    }

    return () => {
      if (throttleTimer.current) clearTimeout(throttleTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { counts, total, activeFiles, logEvents, failures, isDone, doneStats, durationMs, runId, errorMsg } = state;

  // Error state
  if (errorMsg) {
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Text bold color="red">Sync error</Text>
        <Text color="red">{errorMsg}</Text>
        <Text dimColor>[q/Esc] back to home</Text>
      </Box>
    );
  }

  // Summary screen after run:done
  if (isDone && doneStats) {
    return (
      <Summary
        runId={runId}
        stats={doneStats}
        durationMs={durationMs}
        failures={failures}
        onHome={onHome}
        onRetry={() => {
          // Re-navigate: just go home and let user pick "retry failed"
          onHome();
        }}
      />
    );
  }

  const serverHost = (() => {
    try { return new URL(config.serverUrl).host; } catch { return config.serverUrl; }
  })();

  const folderCount = all
    ? (new FolderRepo(db).list({ enabledOnly: true }).length)
    : (folderIds?.length ?? 0);

  return (
    <Box flexDirection="column" gap={1}>
      {/* Header */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" paddingX={1}>
        <StatusLine
          serverUrl={serverHost}
          folderCount={folderCount}
          isDone={isDone}
          durationMs={durationMs}
        />
      </Box>

      {/* Context meter */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Progress</Text>
        <Box marginTop={1}>
          <ContextMeter counts={counts} total={total || 1} />
        </Box>
        <Box marginTop={1}>
          <Legend counts={counts} total={total || 1} />
        </Box>
      </Box>

      {/* Active uploads */}
      {activeFiles.length > 0 && (
        <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
          <ActiveUploads files={activeFiles} />
        </Box>
      )}

      {/* Event log */}
      {logEvents.length > 0 && (
        <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
          <EventLog events={logEvents} />
        </Box>
      )}

      {/* Key hints */}
      <Box paddingLeft={1}>
        <Text dimColor>[q/Esc] cancel and return to home</Text>
      </Box>
    </Box>
  );
}
