/**
 * tui/OrganizeScreen.tsx — App-hosted "Organize folder by date" screen.
 *
 * Offline reorganize: MOVES local media files into `YEAR/MM - Month/`
 * sub-folders by EXIF capture date (files with no capture date — including all
 * videos — go to a top-level `NODATE/` folder). Because the operation is
 * destructive, the screen enforces a plan → confirm → execute flow and never
 * moves a file without an explicit 'y' confirmation.
 *
 * Like ScanScreen this lives inside the running Ink app tree and takes
 * onBack/onHome callbacks. Organize is fully offline (no PAT/login), so there
 * is no not-logged-in gate.
 *
 * Phases:
 *   'planning' — on mount, dry-run the engine to compute the plan (live count).
 *   'confirm'  — show the plan and prompt [y] organize / [q/Esc] cancel.
 *   'running'  — on 'y', run the engine for real with live progress.
 *   'done'     — final totals + [q/Esc] back, [h] home.
 *   'empty'    — dry-run found 0 files.
 *   'error'    — engine error (red border).
 *
 * Keys: while planning/running all keys are ignored; in confirm 'y' proceeds and
 * q/Esc cancels; in done/empty/error q/Esc → back, h → home.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type BetterSqlite3 from 'better-sqlite3';

import { OrganizeEngine } from '../organize/organize-engine.js';
import {
  ORGANIZE_EV,
  type OrganizeProgressPayload,
  type OrganizeDonePayload,
  type OrganizeErrorPayload,
  type OrganizeTotals,
} from '../organize/events.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OrganizeScreenProps {
  db: BetterSqlite3.Database;
  all?: boolean;
  folderIds?: number[];
  onHome: () => void;
  onBack: () => void;
  /**
   * Optional pre-built engine for tests. When provided the screen subscribes to
   * this engine's events for each pass; the caller drives engine.run().
   */
  _engineForTesting?: OrganizeEngine;
}

type Phase = 'planning' | 'confirm' | 'running' | 'done' | 'empty' | 'error';

interface ScreenState {
  phase: Phase;
  processed: number;
  total: number;
  planTotals: OrganizeTotals | null;
  finalTotals: OrganizeTotals | null;
  errorMsg: string | null;
}

// Max per-bucket rows shown in the plan breakdown.
const MAX_BUCKET_ROWS = 8;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrganizeScreen({
  db,
  all,
  folderIds,
  onHome,
  onBack,
  _engineForTesting,
}: OrganizeScreenProps): React.ReactElement {
  const [state, setState] = useState<ScreenState>({
    phase: 'planning',
    processed: 0,
    total: 0,
    planTotals: null,
    finalTotals: null,
    errorMsg: null,
  });

  // Guard against setState after unmount.
  const mounted = useRef(true);
  // The engine instance is shared across both passes (plan then execute).
  const engineRef = useRef<OrganizeEngine | null>(null);
  // Detaches the listeners of the current pass; replaced on every subscribe.
  const cleanupRef = useRef<(() => void) | null>(null);

  // -------------------------------------------------------------------------
  // Subscribe fresh listeners and (unless a test engine is injected) kick off a
  // single run pass. Used for both the dry-run plan pass and the real execute
  // pass — the done handler branches on `dryRun` to route to confirm vs. done.
  // -------------------------------------------------------------------------
  function startPass(dryRun: boolean): void {
    const engine = engineRef.current;
    if (!engine) return;

    // Detach any previous pass's listeners before attaching new ones.
    cleanupRef.current?.();

    const onProgress = ({ processed, total }: OrganizeProgressPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, processed, total }));
    };
    const onDone = ({ totals }: OrganizeDonePayload): void => {
      if (!mounted.current) return;
      if (dryRun) {
        setState((s) => ({
          ...s,
          phase: totals.total === 0 ? 'empty' : 'confirm',
          planTotals: totals,
        }));
      } else {
        setState((s) => ({ ...s, phase: 'done', finalTotals: totals }));
      }
    };
    const onError = ({ message }: OrganizeErrorPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, phase: 'error', errorMsg: message }));
    };

    engine.on(ORGANIZE_EV.ORGANIZE_PROGRESS, onProgress);
    engine.on(ORGANIZE_EV.ORGANIZE_DONE, onDone);
    engine.on(ORGANIZE_EV.ERROR, onError);

    cleanupRef.current = () => {
      engine.off(ORGANIZE_EV.ORGANIZE_PROGRESS, onProgress);
      engine.off(ORGANIZE_EV.ORGANIZE_DONE, onDone);
      engine.off(ORGANIZE_EV.ERROR, onError);
    };

    // When an engine is injected for tests, the test drives run() itself.
    if (!_engineForTesting) {
      engine
        .run({ all, folderIds, dryRun })
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
  }

  useInput((input, key) => {
    // Ignore keys while a pass is actively running.
    if (state.phase === 'planning' || state.phase === 'running') return;

    if (state.phase === 'confirm') {
      if (input === 'y' || input === 'Y') {
        // Confirmed — start the destructive execute pass with fresh listeners.
        setState((s) => ({
          ...s,
          phase: 'running',
          processed: 0,
          total: s.planTotals?.total ?? 0,
        }));
        startPass(false);
        return;
      }
      if (input === 'q' || key.escape) { onBack(); return; }
      return;
    }

    // done / empty / error
    if (input === 'q' || key.escape) { onBack(); return; }
    if (input === 'h') { onHome(); return; }
  });

  useEffect(() => {
    mounted.current = true;

    engineRef.current =
      _engineForTesting ??
      new OrganizeEngine({ folders: new FolderRepo(db), settings: new SettingsRepo(db) });

    // Plan pass — dry-run to compute buckets/targets without touching disk.
    startPass(true);

    return () => {
      mounted.current = false;
      cleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (state.phase === 'planning') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Organize by Date</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>
            {'  '}
            {state.total > 0
              ? `Analyzing… ${state.processed}/${state.total} files`
              : `Analyzing… ${state.processed} files`}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Reading capture dates (no files moved yet) · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'confirm') {
    const totals = state.planTotals;
    const buckets = totals
      ? Object.entries(totals.byBucket).sort((a, b) => b[1] - a[1]).slice(0, MAX_BUCKET_ROWS)
      : [];
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Organize by Date — Plan</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color="green">{totals?.moved ?? 0}</Text> file(s) would move into YEAR/MM - Month/ folders
          </Text>
          <Text>
            <Text color="blue">{totals?.skipped ?? 0}</Text> already in place (skipped)
          </Text>
          <Text>
            <Text color="yellow">{totals?.nodate ?? 0}</Text> → NODATE (no capture date; includes videos)
          </Text>
        </Box>

        {buckets.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Destination breakdown:</Text>
            {buckets.map(([bucket, count]) => (
              <Text key={bucket}>
                {'  '}{bucket}  <Text dimColor>({count})</Text>
              </Text>
            ))}
          </Box>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">⚠ This MOVES files on disk and is not automatically reversible.</Text>
          <Box marginTop={1}>
            <Text>
              <Text color="green">[y]</Text> organize now   <Text dimColor>[q/Esc] cancel</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'running') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Organizing…</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>
            {'  '}
            {state.total > 0
              ? `${state.processed}/${state.total} files`
              : `${state.processed} files`}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Moving files into date folders · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'empty') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Organize by Date</Text>
        <Box marginTop={1}>
          <Text dimColor>No media files found in the selected folder(s). Nothing to organize.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[q/Esc] back   [h] home</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'error') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="red">Organize failed</Text>
        <Box marginTop={1}>
          <Text color="red">{state.errorMsg ?? 'Unknown error'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[q/Esc] back   [h] home</Text>
        </Box>
      </Box>
    );
  }

  // done phase
  const totals = state.finalTotals;
  return (
    <Box borderStyle={BOX_BORDER} borderColor="green" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="green">Organize complete</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="green">{totals?.moved ?? 0}</Text> moved
        </Text>
        <Text>
          <Text color="blue">{totals?.skipped ?? 0}</Text> skipped (already in place)
        </Text>
        <Text>
          <Text color="yellow">{totals?.nodate ?? 0}</Text> → NODATE
        </Text>
        <Text>
          <Text color="cyan">{totals?.conflicts ?? 0}</Text> renamed (name conflicts)
        </Text>
        <Text>
          <Text color={totals && totals.errors > 0 ? 'red' : undefined}>{totals?.errors ?? 0}</Text> errors
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[q/Esc] back   [h] home</Text>
      </Box>
    </Box>
  );
}
