/**
 * tui/DateInferenceScreen.tsx — App-hosted "Date Inference" screen.
 *
 * Offline: infers missing capture dates from filenames (e.g.
 * `20151107_135151000_iOS.jpg`, `IMG-20151228-WA0007.jpg`) for photos/videos
 * that have no EXIF/container date. A read-only 'diagnose' pass always runs
 * first (mirrors OrganizeScreen's dry-run-first plan/confirm/execute flow);
 * when the screen was opened in 'apply' mode, the user can additionally
 * confirm writing the inferred dates into each file via ExifTool.
 *
 * Phases:
 *   'diagnosing'   — on mount, read-only pass (no writes) computing candidates.
 *   'report'       — shows the breakdown + a sample of matched filenames; the
 *                    diagnose report is auto-exported. Terminal state when
 *                    opened in 'diagnose' mode, or when there is nothing to
 *                    apply. In 'apply' mode with candidates, offers [a].
 *   'checkingTool' — after [a], verifying ExifTool is available.
 *   'toolUnavailable' — ExifTool could not be loaded; shows the install hint.
 *   'confirm'      — warns this WRITES to disk; [y] proceeds, [q/Esc] cancels
 *                    back to 'report'.
 *   'applying'     — real engine run in 'apply' mode with live progress.
 *   'done'         — final totals + export path.
 *   'empty'        — diagnose found 0 files.
 *   'error'        — engine error (red border).
 */

import React, { useState, useEffect, useRef } from 'react';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type BetterSqlite3 from 'better-sqlite3';

import { DateInferenceEngine, type DateInferenceMode } from '../date-inference/date-inference-engine.js';
import {
  DATE_INFERENCE_EV,
  type DateInferenceProgressPayload,
  type DateInferenceDonePayload,
  type DateInferenceErrorPayload,
  type DateInferenceFilePayload,
  type DateInferenceTotals,
} from '../date-inference/events.js';
import { detectExiftool, exiftoolInstallHint, endExiftool } from '../date-inference/exif-writer.js';
import { exportDateInference } from '../export/date-inference-export.js';
import { exportsDir } from '../paths.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DateInferenceScreenProps {
  db: BetterSqlite3.Database;
  mode: DateInferenceMode;
  all?: boolean;
  folderIds?: number[];
  onHome: () => void;
  onBack: () => void;
  /**
   * Optional pre-built engine for tests. When provided the screen subscribes
   * to this engine's events for each pass; the caller drives engine.run().
   */
  _engineForTesting?: DateInferenceEngine;
}

type Phase =
  | 'diagnosing'
  | 'report'
  | 'checkingTool'
  | 'toolUnavailable'
  | 'confirm'
  | 'applying'
  | 'done'
  | 'empty'
  | 'error';

interface ScreenState {
  phase: Phase;
  processed: number;
  total: number;
  diagnoseTotals: DateInferenceTotals | null;
  applyTotals: DateInferenceTotals | null;
  fileRecords: DateInferenceFilePayload[];
  exportPath: string | null;
  errorMsg: string | null;
}

const MAX_SAMPLE_ROWS = 8;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DateInferenceScreen({
  db,
  mode,
  all,
  folderIds,
  onHome,
  onBack,
  _engineForTesting,
}: DateInferenceScreenProps): React.ReactElement {
  const [state, setState] = useState<ScreenState>({
    phase: 'diagnosing',
    processed: 0,
    total: 0,
    diagnoseTotals: null,
    applyTotals: null,
    fileRecords: [],
    exportPath: null,
    errorMsg: null,
  });

  const mounted = useRef(true);
  const engineRef = useRef<DateInferenceEngine | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  function startPass(passMode: DateInferenceMode): void {
    const engine = engineRef.current;
    if (!engine) return;

    cleanupRef.current?.();

    const records: DateInferenceFilePayload[] = [];
    const onFile = (payload: DateInferenceFilePayload): void => {
      records.push(payload);
    };
    const onProgress = ({ processed, total }: DateInferenceProgressPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, processed, total }));
    };
    const onDone = ({ totals }: DateInferenceDonePayload): void => {
      if (!mounted.current) return;

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = exportsDir();
      fs.mkdirSync(dir, { recursive: true });
      const outPath = path.join(dir, `date-infer-${passMode}-${stamp}.xlsx`);
      exportDateInference(totals, passMode, records, outPath, 'xlsx').catch(() => {});

      if (passMode === 'diagnose') {
        setState((s) => ({
          ...s,
          phase: totals.total === 0 ? 'empty' : 'report',
          diagnoseTotals: totals,
          fileRecords: records,
          exportPath: outPath,
        }));
      } else {
        endExiftool()
          .catch(() => {})
          .finally(() => {
            if (mounted.current) {
              setState((s) => ({
                ...s,
                phase: 'done',
                applyTotals: totals,
                fileRecords: records,
                exportPath: outPath,
              }));
            }
          });
      }
    };
    const onError = ({ message }: DateInferenceErrorPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, phase: 'error', errorMsg: message }));
    };

    engine.on(DATE_INFERENCE_EV.FILE, onFile);
    engine.on(DATE_INFERENCE_EV.PROGRESS, onProgress);
    engine.on(DATE_INFERENCE_EV.DONE, onDone);
    engine.on(DATE_INFERENCE_EV.ERROR, onError);

    cleanupRef.current = () => {
      engine.off(DATE_INFERENCE_EV.FILE, onFile);
      engine.off(DATE_INFERENCE_EV.PROGRESS, onProgress);
      engine.off(DATE_INFERENCE_EV.DONE, onDone);
      engine.off(DATE_INFERENCE_EV.ERROR, onError);
    };

    if (!_engineForTesting) {
      engine
        .run({ all, folderIds, mode: passMode })
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
    if (state.phase === 'diagnosing' || state.phase === 'applying' || state.phase === 'checkingTool') return;

    if (state.phase === 'report') {
      const canApply = mode === 'apply' && (state.diagnoseTotals?.inferred ?? 0) > 0;
      if (canApply && input === 'a') {
        setState((s) => ({ ...s, phase: 'checkingTool' }));
        detectExiftool().then((info) => {
          if (!mounted.current) return;
          setState((s) => ({ ...s, phase: info.available ? 'confirm' : 'toolUnavailable' }));
        });
        return;
      }
      if (input === 'q' || key.escape) { onBack(); return; }
      if (input === 'h') { onHome(); return; }
      return;
    }

    if (state.phase === 'toolUnavailable') {
      if (input === 'q' || key.escape) { setState((s) => ({ ...s, phase: 'report' })); return; }
      if (input === 'h') { onHome(); return; }
      return;
    }

    if (state.phase === 'confirm') {
      if (input === 'y' || input === 'Y') {
        setState((s) => ({ ...s, phase: 'applying', processed: 0, total: s.diagnoseTotals?.total ?? 0 }));
        startPass('apply');
        return;
      }
      if (input === 'q' || key.escape) { setState((s) => ({ ...s, phase: 'report' })); return; }
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
      new DateInferenceEngine({ folders: new FolderRepo(db), settings: new SettingsRepo(db) });

    startPass('diagnose');

    return () => {
      mounted.current = false;
      cleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (state.phase === 'diagnosing') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Date Inference</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>
            {'  '}
            {state.total > 0
              ? `Diagnosing… ${state.processed}/${state.total} files`
              : `Diagnosing… ${state.processed} files`}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Checking existing dates and filenames (nothing written yet) · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'checkingTool') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Date Inference</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>  Checking for ExifTool…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'toolUnavailable') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="red">ExifTool is not available</Text>
        <Box marginTop={1}>
          <Text>{exiftoolInstallHint()}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[q/Esc] back to report   [h] home</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'report' || state.phase === 'confirm') {
    const totals = state.diagnoseTotals;
    const canApply = mode === 'apply' && (totals?.inferred ?? 0) > 0;
    const samples = state.fileRecords
      .filter((f) => f.status === 'inferred')
      .slice(0, MAX_SAMPLE_ROWS);

    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Date Inference — Report</Text>
        <Box marginTop={1} flexDirection="column">
          <Text><Text color="cyan">{totals?.total ?? 0}</Text> file(s) scanned</Text>
          <Text><Text dimColor>{totals?.hasDate ?? 0}</Text> already have a capture date</Text>
          <Text><Text color="green">{totals?.inferred ?? 0}</Text> date(s) can be inferred from the filename</Text>
          <Text><Text color="yellow">{totals?.noPattern ?? 0}</Text> have no date and no recognizable filename pattern</Text>
        </Box>

        {samples.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Sample matches:</Text>
            {samples.map((f) => (
              <Text key={f.filePath}>
                {'  '}{path.basename(f.filePath)} → {f.inferredDate?.slice(0, 10)} <Text dimColor>({f.matchedPattern})</Text>
              </Text>
            ))}
          </Box>
        )}

        {state.exportPath && (
          <Box marginTop={1}>
            <Text dimColor>Report: {state.exportPath}</Text>
          </Box>
        )}

        {state.phase === 'confirm' ? (
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow">⚠ This WRITES metadata into {totals?.inferred ?? 0} file(s) on disk.</Text>
            <Box marginTop={1}>
              <Text>
                <Text color="green">[y]</Text> write dates now   <Text dimColor>[q/Esc] cancel</Text>
              </Text>
            </Box>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text dimColor>
              {canApply ? '[a] write inferred dates   ' : ''}[q/Esc] back   [h] home
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (state.phase === 'applying') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Writing dates…</Text>
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
          <Text dimColor>Writing capture dates via ExifTool · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'empty') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Date Inference</Text>
        <Box marginTop={1}>
          <Text dimColor>No media files found in the selected folder(s). Nothing to diagnose.</Text>
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
        <Text bold color="red">Date Inference failed</Text>
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
  const totals = state.applyTotals;
  return (
    <Box borderStyle={BOX_BORDER} borderColor="green" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="green">Date Inference complete</Text>
      <Box marginTop={1} flexDirection="column">
        <Text><Text color="green">{totals?.written ?? 0}</Text> date(s) written</Text>
        <Text><Text color={totals && totals.writeFailed > 0 ? 'red' : undefined}>{totals?.writeFailed ?? 0}</Text> write failure(s)</Text>
        <Text><Text dimColor>{totals?.hasDate ?? 0}</Text> already had a date</Text>
        <Text><Text color="yellow">{totals?.noPattern ?? 0}</Text> no date found</Text>
      </Box>
      {state.exportPath && (
        <Box marginTop={1}>
          <Text dimColor>Report: {state.exportPath}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>[q/Esc] back   [h] home</Text>
      </Box>
    </Box>
  );
}
