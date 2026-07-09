/**
 * tui/ConvertScreen.tsx — App-hosted "Convert videos to MP4" screen.
 *
 * Converts recognized non-MP4 video files (MOV, MTS, AVI, WMV, …) to `.mp4`
 * alongside the originals via ffmpeg.  Because the operation creates files, the
 * screen uses a plan → confirm → execute flow and never runs ffmpeg without an
 * explicit 'y' confirmation.  On the confirm screen the user also chooses what
 * happens to each original once its `.mp4` is written — keep (default), delete,
 * or move into a chosen folder.
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
import TextInput from 'ink-text-input';
import type BetterSqlite3 from 'better-sqlite3';

import { ConvertEngine } from '../convert/convert-engine.js';
import {
  CONVERT_EV,
  type ConvertProgressPayload,
  type ConvertFilePayload,
  type ConvertDonePayload,
  type ConvertErrorPayload,
  type ConvertTotals,
  type OriginalDisposition,
} from '../convert/events.js';
import {
  writeConvertErrorReport,
  summarizeConvertErrors,
  type ConvertErrorEntry,
  type ConvertErrorGroup,
} from '../convert/error-report.js';
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
  /** Chosen disposition for the originals (selected on the confirm screen). */
  disposition: OriginalDisposition;
  /** Destination folder for moved originals (disposition 'move'). */
  originalsDir: string;
  /** True while the move-destination text field is being edited. */
  editingDir: boolean;
  /** Inline validation message shown on the confirm screen. */
  confirmError: string | null;
  /** Grouped per-file failures shown on the done screen. */
  errorGroups: ConvertErrorGroup[];
  /** Path of the written full error report (null when there were no errors). */
  reportPath: string | null;
}

/** Human labels for each disposition, shown on the confirm + done screens. */
const DISPOSITION_LABELS: Record<OriginalDisposition, string> = {
  keep: 'Keep originals',
  delete: 'Delete originals after conversion',
  move: 'Move originals to a folder',
};

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
    disposition: 'keep',
    originalsDir: '',
    editingDir: false,
    confirmError: null,
    errorGroups: [],
    reportPath: null,
  });

  // Per-file errors collected during the current execute pass.
  const errorsRef = useRef<ConvertErrorEntry[]>([]);
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
  function startPass(
    dryRun: boolean,
    runOpts?: { originalDisposition?: OriginalDisposition; originalsDir?: string },
  ): void {
    const engine = engineRef.current;
    if (!engine) return;

    // Detach any previous pass's listeners before attaching new ones.
    cleanupRef.current?.();

    // Fresh error collection for this pass.
    if (!dryRun) errorsRef.current = [];

    const onProgress = ({ processed, total }: ConvertProgressPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, processed, total }));
    };
    const onFile = (p: ConvertFilePayload): void => {
      if (!dryRun && p.action === 'error' && p.error) {
        errorsRef.current.push({ filePath: p.filePath, error: p.error });
      }
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
        // Write a full error report (best-effort) and surface a grouped summary.
        let errorGroups: ConvertErrorGroup[] = [];
        let reportPath: string | null = null;
        if (errorsRef.current.length > 0) {
          errorGroups = summarizeConvertErrors(errorsRef.current);
          try {
            reportPath = writeConvertErrorReport(errorsRef.current);
          } catch {
            reportPath = null;
          }
        }
        setState((s) => ({ ...s, phase: 'done', finalTotals: totals, errorGroups, reportPath }));
      }
    };
    const onError = ({ message }: ConvertErrorPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, phase: 'error', errorMsg: message }));
    };

    engine.on(CONVERT_EV.CONVERT_PROGRESS, onProgress);
    engine.on(CONVERT_EV.CONVERT_FILE, onFile);
    engine.on(CONVERT_EV.CONVERT_DONE, onDone);
    engine.on(CONVERT_EV.ERROR, onError);

    cleanupRef.current = () => {
      engine.off(CONVERT_EV.CONVERT_PROGRESS, onProgress);
      engine.off(CONVERT_EV.CONVERT_FILE, onFile);
      engine.off(CONVERT_EV.CONVERT_DONE, onDone);
      engine.off(CONVERT_EV.ERROR, onError);
    };

    // When an engine is injected for tests, the test drives run() itself.
    if (!_engineForTesting) {
      engine
        .run({ all, folderIds, files, dryRun, ...runOpts })
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
      // While editing the move-destination field, the TextInput owns typing;
      // Esc cancels editing without leaving the screen.
      if (state.editingDir) {
        if (key.escape) setState((s) => ({ ...s, editingDir: false }));
        return;
      }
      // Disposition selection.
      if (input === '1') { setState((s) => ({ ...s, disposition: 'keep', editingDir: false, confirmError: null })); return; }
      if (input === '2') { setState((s) => ({ ...s, disposition: 'delete', editingDir: false, confirmError: null })); return; }
      if (input === '3') { setState((s) => ({ ...s, disposition: 'move', editingDir: true, confirmError: null })); return; }
      if (input === 'y' || input === 'Y') {
        if (state.disposition === 'move' && state.originalsDir.trim().length === 0) {
          setState((s) => ({
            ...s,
            editingDir: true,
            confirmError: 'Enter a destination folder for the originals, then press Enter.',
          }));
          return;
        }
        // Confirmed — start the execute pass with fresh listeners.
        const originalsDir = state.originalsDir.trim();
        setState((s) => ({
          ...s,
          phase: 'running',
          processed: 0,
          total: s.planTotals?.total ?? 0,
        }));
        startPass(false, {
          originalDisposition: state.disposition,
          originalsDir: state.disposition === 'move' ? originalsDir : undefined,
        });
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
    const opts: OriginalDisposition[] = ['keep', 'delete', 'move'];
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Convert Videos to MP4 — Plan</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color="green">{totals?.total ?? 0}</Text> video file(s) would be converted to .mp4
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>What should happen to the original videos?</Text>
          {opts.map((d, i) => {
            const selected = state.disposition === d;
            return (
              <Text key={d} color={selected ? 'green' : undefined}>
                {selected ? '❯ ' : '  '}[{i + 1}] {DISPOSITION_LABELS[d]}
              </Text>
            );
          })}
          {state.disposition === 'move' && (
            <Box marginTop={1}>
              <Text color="cyan">{'  Folder: '}</Text>
              {state.editingDir ? (
                <TextInput
                  value={state.originalsDir}
                  onChange={(v) => setState((s) => ({ ...s, originalsDir: v }))}
                  onSubmit={() => setState((s) => ({ ...s, editingDir: false }))}
                />
              ) : (
                <Text dimColor>
                  {state.originalsDir.trim().length > 0
                    ? state.originalsDir
                    : '(not set — press 3 to enter a folder)'}
                </Text>
              )}
            </Box>
          )}
        </Box>

        {state.confirmError && (
          <Box marginTop={1}>
            <Text color="red">{state.confirmError}</Text>
          </Box>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">⚠ Conversion requires ffmpeg and may take a while for large videos.</Text>
          <Box marginTop={1}>
            {state.editingDir ? (
              <Text dimColor>[Enter] set folder   [Esc] cancel edit</Text>
            ) : (
              <Text>
                <Text dimColor>[1/2/3] choose   </Text>
                <Text color="green">[y]</Text> convert now   <Text dimColor>[q/Esc] cancel</Text>
              </Text>
            )}
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
        {(totals?.moved ?? 0) > 0 && (
          <Text>
            <Text color="yellow">{totals?.moved ?? 0}</Text> originals moved
            {state.originalsDir.trim().length > 0 && (
              <Text dimColor> → {state.originalsDir.trim()}</Text>
            )}
          </Text>
        )}
        <Text>
          <Text color={totals && totals.errors > 0 ? 'red' : undefined}>{totals?.errors ?? 0}</Text> errors
        </Text>
      </Box>

      {state.errorGroups.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>Why they failed:</Text>
          {state.errorGroups.slice(0, 5).map((g, i) => (
            <Text key={i} color="red">
              {'  '}{g.count}×  <Text dimColor>{g.message}</Text>
            </Text>
          ))}
          {state.errorGroups.length > 5 && (
            <Text dimColor>{'  '}… and {state.errorGroups.length - 5} more distinct error(s)</Text>
          )}
          {state.reportPath && (
            <Box marginTop={1}>
              <Text dimColor>Full per-file report: {state.reportPath}</Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>[q/Esc] back   [h] home</Text>
      </Box>
    </Box>
  );
}
