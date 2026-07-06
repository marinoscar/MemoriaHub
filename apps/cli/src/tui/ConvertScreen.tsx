/**
 * tui/ConvertScreen.tsx — App-hosted "Convert videos to MP4" screen.
 *
 * Converts recognized non-MP4 video files (MOV, MTS, AVI, WMV, …) to `.mp4`
 * alongside the originals via ffmpeg.  Because the operation creates files (and
 * originals are kept), the screen still uses a plan → confirm → execute flow and
 * never runs ffmpeg without an explicit 'y' confirmation.
 *
 * Like OrganizeScreen this lives inside the running Ink app tree and takes
 * onBack/onHome callbacks.  Convert is fully offline (no PAT/login), so there is
 * no not-logged-in gate.  ffmpeg's absence surfaces as the 'error' phase (the
 * engine emits ERROR from the real execute pass).
 *
 * Phases:
 *   'planning' — on mount, dry-run the engine to compute the plan (live count).
 *   'confirm'  — show the plan and prompt [y] convert / [q/Esc] cancel.
 *   'running'  — on 'y', run the engine for real with live progress.
 *   'done'     — final totals + [q/Esc] back, [h] home.
 *   'empty'    — dry-run found 0 convertible files.
 *   'error'    — engine error, e.g. ffmpeg not installed (red border).
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type BetterSqlite3 from 'better-sqlite3';

import { ConvertEngine } from '../convert/convert-engine.js';
import {
  CONVERT_EV,
  type ConvertProgressPayload,
  type ConvertDonePayload,
  type ConvertErrorPayload,
  type ConvertTotals,
} from '../convert/events.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ConvertScreenProps {
  db: BetterSqlite3.Database;
  all?: boolean;
  folderIds?: number[];
  files?: string[];
  onHome: () => void;
  onBack: () => void;
  /**
   * Optional pre-built engine for tests. When provided the screen subscribes to
   * this engine's events for each pass; the caller drives engine.run().
   */
  _engineForTesting?: ConvertEngine;
}

type Phase = 'planning' | 'confirm' | 'running' | 'done' | 'empty' | 'error';

interface ScreenState {
  phase: Phase;
  processed: number;
  total: number;
  planTotals: ConvertTotals | null;
  finalTotals: ConvertTotals | null;
  errorMsg: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConvertScreen({
  db,
  all,
  folderIds,
  files,
  onHome,
  onBack,
  _engineForTesting,
}: ConvertScreenProps): React.ReactElement {
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
  const engineRef = useRef<ConvertEngine | null>(null);
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

    const onProgress = ({ processed, total }: ConvertProgressPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, processed, total }));
    };
    const onDone = ({ totals }: ConvertDonePayload): void => {
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
    const onError = ({ message }: ConvertErrorPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, phase: 'error', errorMsg: message }));
    };

    engine.on(CONVERT_EV.CONVERT_PROGRESS, onProgress);
    engine.on(CONVERT_EV.CONVERT_DONE, onDone);
    engine.on(CONVERT_EV.ERROR, onError);

    cleanupRef.current = () => {
      engine.off(CONVERT_EV.CONVERT_PROGRESS, onProgress);
      engine.off(CONVERT_EV.CONVERT_DONE, onDone);
      engine.off(CONVERT_EV.ERROR, onError);
    };

    // When an engine is injected for tests, the test drives run() itself.
    if (!_engineForTesting) {
      engine
        .run({ all, folderIds, files, dryRun })
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
        // Confirmed — start the execute pass with fresh listeners.
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
      new ConvertEngine({ folders: new FolderRepo(db), settings: new SettingsRepo(db) });

    // Plan pass — dry-run to count convertible files without running ffmpeg.
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
        <Text bold color="cyan">Convert Videos to MP4</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>
            {'  '}
            {state.total > 0
              ? `Scanning… ${state.processed}/${state.total} files`
              : `Scanning… ${state.processed} files`}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Finding convertible videos (nothing converted yet) · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'confirm') {
    const totals = state.planTotals;
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Convert Videos to MP4 — Plan</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color="green">{totals?.total ?? 0}</Text> video file(s) would be converted to .mp4
          </Text>
          <Text dimColor>Originals are kept alongside the new .mp4 files.</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">⚠ Conversion requires ffmpeg and may take a while for large videos.</Text>
          <Box marginTop={1}>
            <Text>
              <Text color="green">[y]</Text> convert now   <Text dimColor>[q/Esc] cancel</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'running') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Converting…</Text>
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
          <Text dimColor>Transcoding videos to MP4 · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'empty') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Convert Videos to MP4</Text>
        <Box marginTop={1}>
          <Text dimColor>No convertible video files found. Nothing to convert.</Text>
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
        <Text bold color="red">Convert failed</Text>
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
      <Text bold color="green">Convert complete</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="green">{totals?.converted ?? 0}</Text> converted
          {'  '}
          <Text dimColor>({totals?.remuxed ?? 0} remux · {totals?.reencoded ?? 0} re-encode)</Text>
        </Text>
        <Text>
          <Text color="blue">{totals?.skipped ?? 0}</Text> skipped (already exists)
        </Text>
        {(totals?.deleted ?? 0) > 0 && (
          <Text>
            <Text color="yellow">{totals?.deleted ?? 0}</Text> originals deleted
          </Text>
        )}
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
