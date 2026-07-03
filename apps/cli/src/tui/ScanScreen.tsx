/**
 * tui/ScanScreen.tsx — App-hosted scan screen for the interactive menu.
 *
 * Unlike ScanDashboard (self-rendering + self-exiting, used by the headless
 * `scan` command), this screen lives inside the running Ink app tree and takes
 * onBack/onHome callbacks like SyncDashboard/ReportView.
 *
 *   mode='run'  (default) — run a scan (all or selected folders), showing live
 *                           progress, then render the resulting report.
 *   mode='view'           — load and render the latest completed scan report.
 *
 * Scan is fully offline (no PAT/login), so there is no not-logged-in gate.
 *
 * Keys (once the report/empty/error is shown): q/Esc → back, h → home.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type BetterSqlite3 from 'better-sqlite3';

import { ScanEngine } from '../scan/scan-engine.js';
import { SCAN_EV } from '../scan/events.js';
import { buildScanReport, type ScanReport } from '../scan/report.js';
import { ScanRepo } from '../repo/scans.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { ScanReportBody } from './ScanDashboard.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ScanScreenProps {
  db: BetterSqlite3.Database;
  /** 'run' scans then shows the report; 'view' shows the latest stored scan. */
  mode?: 'run' | 'view';
  all?: boolean;
  folderIds?: number[];
  onHome: () => void;
  onBack: () => void;
  /**
   * Optional pre-built engine for tests. When provided (run mode), the screen
   * subscribes to this engine's events; the caller drives engine.run().
   */
  _engineForTesting?: ScanEngine;
}

type Phase = 'running' | 'report' | 'empty' | 'error';

interface ScreenState {
  phase: Phase;
  scanned: number;
  total: number;
  report: ScanReport | null;
  errorMsg: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScanScreen({
  db,
  mode = 'run',
  all,
  folderIds,
  onHome,
  onBack,
  _engineForTesting,
}: ScanScreenProps): React.ReactElement {
  const [state, setState] = useState<ScreenState>({
    phase: mode === 'view' ? 'report' : 'running',
    scanned: 0,
    total: 0,
    report: null,
    errorMsg: null,
  });

  // Guard against setState after unmount.
  const mounted = useRef(true);

  useInput((input, key) => {
    // Ignore keys while a scan is actively running.
    if (state.phase === 'running') return;
    if (input === 'q' || key.escape) { onBack(); return; }
    if (input === 'h') { onHome(); return; }
  });

  useEffect(() => {
    mounted.current = true;

    const scans = new ScanRepo(db);
    const folders = new FolderRepo(db);

    // ----- view mode: load the latest completed scan -----
    if (mode === 'view') {
      try {
        const latest = scans.latestComplete();
        if (!latest) {
          setState((s) => ({ ...s, phase: 'empty' }));
        } else {
          const report = buildScanReport(scans, folders, latest.id);
          setState((s) => ({ ...s, phase: 'report', report }));
        }
      } catch (err) {
        setState((s) => ({
          ...s,
          phase: 'error',
          errorMsg: err instanceof Error ? err.message : String(err),
        }));
      }
      return () => { mounted.current = false; };
    }

    // ----- run mode: run the scan engine, then build the report -----
    const engine =
      _engineForTesting ??
      new ScanEngine({ scans, folders, settings: new SettingsRepo(db) });

    const onProgress = ({ scanned, total }: { scanned: number; total: number }): void => {
      if (mounted.current) setState((s) => ({ ...s, scanned, total }));
    };
    const onDone = ({ scanId }: { scanId: number }): void => {
      if (!mounted.current) return;
      try {
        const report = buildScanReport(scans, folders, scanId);
        setState((s) => ({ ...s, phase: 'report', report }));
      } catch (err) {
        setState((s) => ({
          ...s,
          phase: 'error',
          errorMsg: err instanceof Error ? err.message : String(err),
        }));
      }
    };
    const onError = ({ message }: { message: string }): void => {
      if (mounted.current) setState((s) => ({ ...s, phase: 'error', errorMsg: message }));
    };

    engine.on(SCAN_EV.SCAN_PROGRESS, onProgress);
    engine.on(SCAN_EV.SCAN_DONE, onDone);
    engine.on(SCAN_EV.ERROR, onError);

    // When an engine is injected for tests, the test drives run() itself.
    if (!_engineForTesting) {
      engine
        .run({ all, folderIds, trigger: 'menu' })
        .catch((err: unknown) => {
          if (mounted.current) {
            setState((s) => ({
              ...s,
              phase: 'error',
              errorMsg: err instanceof Error ? err.message : String(err),
            }));
          }
        });
    }

    return () => {
      mounted.current = false;
      engine.off(SCAN_EV.SCAN_PROGRESS, onProgress);
      engine.off(SCAN_EV.SCAN_DONE, onDone);
      engine.off(SCAN_EV.ERROR, onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (state.phase === 'running') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Scanning…</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>
            {'  '}
            {state.total > 0
              ? `${state.scanned}/${state.total} files`
              : `${state.scanned} files`}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Reading metadata (no uploads) · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'empty') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Scan Report</Text>
        <Box marginTop={1}>
          <Text dimColor>No scans yet. Choose “Scan all folders” to create one.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[q/Esc] back   [h] home</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'error' || !state.report) {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="red">Scan failed</Text>
        <Box marginTop={1}>
          <Text color="red">{state.errorMsg ?? 'Unknown error'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[q/Esc] back   [h] home</Text>
        </Box>
      </Box>
    );
  }

  // report phase
  return (
    <Box flexDirection="column" gap={1}>
      <ScanReportBody report={state.report} />
      <Box paddingX={2}>
        <Text dimColor>[q/Esc] back   [h] home</Text>
      </Box>
    </Box>
  );
}
