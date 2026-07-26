/**
 * tui/ScreenshotsScreen.tsx — App-hosted "Find/Move/Delete screenshots" screen.
 *
 * Offline screenshot cleanup: finds files whose name contains "screenshot"
 * (case-insensitive) and, depending on `mode`, lists them, MOVES them into a
 * user-supplied destination folder, or permanently DELETES them.
 *
 * Like OrganizeScreen this lives inside the running Ink app tree and takes
 * onBack/onHome callbacks. Screenshots detection is fully offline (no
 * PAT/login), so there is no not-logged-in gate.
 *
 * Phases:
 *   'destInput' — (mode === 'move' only) prompt for the destination folder.
 *   'scanning'  — dry-run the engine to find matches (live folder count).
 *   'confirm'   — (mode !== 'find') show matches and prompt to proceed.
 *                 'move'   uses a light [y] proceed / [q/Esc] cancel gate.
 *                 'delete' requires typing "y" + Enter (irreversible action).
 *   'running'   — on confirm, run the engine for real with live progress.
 *   'results'   — (mode === 'find') the scan itself is the whole action.
 *   'done'      — (mode !== 'find') final totals + [q/Esc] back, [h] home.
 *   'empty'     — scan found 0 matching files.
 *   'error'     — engine error (red border).
 *
 * Keys: while scanning/running all keys are ignored; in 'confirm' for 'move'
 * mode 'y' proceeds and q/Esc cancels; for 'delete' mode the user must type
 * "y" then Enter; in results/done/empty/error q/Esc → back, h → home.
 */

import React, { useState, useEffect, useRef } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type BetterSqlite3 from 'better-sqlite3';

import { ScreenshotEngine, type ScreenshotMode } from '../screenshots/screenshot-engine.js';
import {
  SCREENSHOTS_EV,
  type ScreenshotsProgressPayload,
  type ScreenshotsDonePayload,
  type ScreenshotsErrorPayload,
  type ScreenshotTotals,
} from '../screenshots/events.js';
import type { ScreenshotMatch } from '../screenshots/plan.js';
import { FolderRepo } from '../repo/folders.js';
import { SettingsRepo } from '../repo/settings.js';
import { formatBytes } from '../format-bytes.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ScreenshotsScreenProps {
  db: BetterSqlite3.Database;
  mode: ScreenshotMode;
  all?: boolean;
  folderIds?: number[];
  onHome: () => void;
  onBack: () => void;
  /**
   * Optional pre-built engine for tests. When provided the screen subscribes to
   * this engine's events for each pass; the caller drives engine.run().
   */
  _engineForTesting?: ScreenshotEngine;
}

type Phase = 'destInput' | 'scanning' | 'confirm' | 'running' | 'results' | 'done' | 'empty' | 'error';

interface ScreenState {
  phase: Phase;
  processed: number;
  total: number;
  scanTotals: ScreenshotTotals | null;
  scanMatches: ScreenshotMatch[];
  finalTotals: ScreenshotTotals | null;
  errorMsg: string | null;
}

// Max sample file rows shown in the match list.
const MAX_FILE_ROWS = 12;

const TITLE: Record<ScreenshotMode, string> = {
  find: 'Find Screenshots',
  move: 'Move Screenshots',
  delete: 'Delete Screenshots',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScreenshotsScreen({
  db,
  mode,
  all,
  folderIds,
  onHome,
  onBack,
  _engineForTesting,
}: ScreenshotsScreenProps): React.ReactElement {
  const [destDir, setDestDir] = useState<string | undefined>(undefined);
  const [destInput, setDestInput] = useState('');
  const [destError, setDestError] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const [state, setState] = useState<ScreenState>({
    phase: mode === 'move' ? 'destInput' : 'scanning',
    processed: 0,
    total: 0,
    scanTotals: null,
    scanMatches: [],
    finalTotals: null,
    errorMsg: null,
  });

  // Guard against setState after unmount.
  const mounted = useRef(true);
  // The engine instance is shared across both passes (scan then execute).
  const engineRef = useRef<ScreenshotEngine | null>(null);
  // Detaches the listeners of the current pass; replaced on every subscribe.
  const cleanupRef = useRef<(() => void) | null>(null);

  // -------------------------------------------------------------------------
  // Subscribe fresh listeners and (unless a test engine is injected) kick off
  // a single run pass. Used for both the dry-run scan pass and the real
  // execute pass — the done handler branches on `dryRun` to route to
  // confirm/results vs. done.
  // -------------------------------------------------------------------------
  function startPass(dryRun: boolean, resolvedDestDir?: string): void {
    const engine = engineRef.current;
    if (!engine) return;

    cleanupRef.current?.();

    const onProgress = (payload: ScreenshotsProgressPayload): void => {
      if (mounted.current) {
        setState((s) => ({ ...s, processed: payload.processed, total: payload.total }));
      }
    };
    const onDone = ({ totals, matches }: ScreenshotsDonePayload): void => {
      if (!mounted.current) return;
      if (dryRun) {
        setState((s) => ({
          ...s,
          phase: totals.matched === 0 ? 'empty' : mode === 'find' ? 'results' : 'confirm',
          scanTotals: totals,
          scanMatches: matches,
        }));
      } else {
        setState((s) => ({ ...s, phase: 'done', finalTotals: totals }));
      }
    };
    const onError = ({ message }: ScreenshotsErrorPayload): void => {
      if (mounted.current) setState((s) => ({ ...s, phase: 'error', errorMsg: message }));
    };

    engine.on(SCREENSHOTS_EV.PROGRESS, onProgress);
    engine.on(SCREENSHOTS_EV.DONE, onDone);
    engine.on(SCREENSHOTS_EV.ERROR, onError);

    cleanupRef.current = () => {
      engine.off(SCREENSHOTS_EV.PROGRESS, onProgress);
      engine.off(SCREENSHOTS_EV.DONE, onDone);
      engine.off(SCREENSHOTS_EV.ERROR, onError);
    };

    // When an engine is injected for tests, the test drives run() itself.
    if (!_engineForTesting) {
      engine
        .run({ all, folderIds, mode, destDir: resolvedDestDir ?? destDir, dryRun })
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

  function beginScan(resolvedDestDir?: string): void {
    setState((s) => ({ ...s, phase: 'scanning', processed: 0, total: 0 }));
    startPass(true, resolvedDestDir);
  }

  function handleDestSubmit(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      onBack();
      return;
    }
    const abs = path.resolve(trimmed);
    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
      setDestError(`That path exists and is not a folder: ${abs}`);
      return;
    }
    setDestError('');
    setDestDir(abs);
    beginScan(abs);
  }

  useInput((input, key) => {
    if (state.phase === 'destInput') {
      // TextInput owns every other keystroke while focused; Esc always cancels.
      if (key.escape) onBack();
      return;
    }

    if (state.phase === 'scanning' || state.phase === 'running') return;

    if (state.phase === 'confirm') {
      if (mode === 'move') {
        if (input === 'y' || input === 'Y') {
          setState((s) => ({ ...s, phase: 'running', processed: 0, total: s.scanTotals?.matched ?? 0 }));
          startPass(false);
          return;
        }
        if (input === 'q' || key.escape) { onBack(); return; }
      }
      // 'delete' confirm is driven by the TextInput below, not raw keys —
      // except Esc, which always cancels.
      if (mode === 'delete' && key.escape) { onBack(); return; }
      return;
    }

    // results / done / empty / error
    if (input === 'q' || key.escape) { onBack(); return; }
    if (input === 'h') { onHome(); return; }
  });

  useEffect(() => {
    mounted.current = true;

    engineRef.current =
      _engineForTesting ??
      new ScreenshotEngine({ folders: new FolderRepo(db), settings: new SettingsRepo(db) });

    // Ad-hoc folders (paths) aren't used by the TUI (folders are always
    // registered via PickFolders/`--all`), so only all/folderIds apply here.
    if (mode !== 'move') {
      beginScan();
    }
    // If mode === 'move', we wait in 'destInput' until the user submits a path.

    return () => {
      mounted.current = false;
      cleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (state.phase === 'destInput') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">{TITLE[mode]}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Enter the destination folder for matched screenshots:</Text>
          <Box marginTop={1}>
            <Text color="cyan">{'› '}</Text>
            <TextInput
              value={destInput}
              onChange={setDestInput}
              onSubmit={handleDestSubmit}
            />
          </Box>
        </Box>
        {destError.length > 0 && (
          <Box marginTop={1}>
            <Text color="red">{destError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>[Enter] continue   [Esc] cancel</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'scanning') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">{TITLE[mode]}</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>
            {'  '}
            {state.total > 0
              ? `Scanning… ${state.processed}/${state.total} folder(s)`
              : `Scanning…`}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Looking for filenames containing "screenshot" · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'confirm') {
    const totals = state.scanTotals;
    const sample = state.scanMatches.slice(0, MAX_FILE_ROWS);
    const actionLabel = mode === 'move' ? 'move' : 'permanently delete';
    return (
      <Box
        borderStyle={BOX_BORDER}
        borderColor={mode === 'delete' ? 'red' : 'cyan'}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color={mode === 'delete' ? 'red' : 'cyan'}>{TITLE[mode]} — Plan</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color="green">{totals?.matched ?? 0}</Text> screenshot(s) found —{' '}
            <Text color="cyan">{formatBytes(totals?.bytes ?? 0)}</Text> total
          </Text>
          {mode === 'move' && <Text dimColor>Destination: {destDir}</Text>}
        </Box>

        {sample.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Sample matches:</Text>
            {sample.map((m) => (
              <Text key={m.filePath}>
                {'  '}{m.filePath}  <Text dimColor>({formatBytes(m.size)})</Text>
              </Text>
            ))}
            {(totals?.matched ?? 0) > sample.length && (
              <Text dimColor>  … and {(totals?.matched ?? 0) - sample.length} more</Text>
            )}
          </Box>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text color={mode === 'delete' ? 'red' : 'yellow'}>
            ⚠ This will {actionLabel} the file(s) above
            {mode === 'delete' ? ' — this is IRREVERSIBLE.' : ' on disk and is not automatically reversible.'}
          </Text>
          {mode === 'move' ? (
            <Box marginTop={1}>
              <Text>
                <Text color="green">[y]</Text> move now   <Text dimColor>[q/Esc] cancel</Text>
              </Text>
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="row" gap={1}>
              <Text dimColor>Type y then Enter to permanently delete, or Esc to cancel:</Text>
              <TextInput
                value={confirmText}
                onChange={setConfirmText}
                onSubmit={(value) => {
                  if (value.trim().toLowerCase() === 'y') {
                    setState((s) => ({ ...s, phase: 'running', processed: 0, total: s.scanTotals?.matched ?? 0 }));
                    startPass(false);
                  } else {
                    onBack();
                  }
                }}
                placeholder="n"
              />
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  if (state.phase === 'running') {
    const verb = mode === 'move' ? 'Moving' : 'Deleting';
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">{verb}…</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>
            {'  '}
            {state.total > 0 ? `${state.processed}/${state.total} files` : `${state.processed} files`}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{verb === 'Moving' ? 'Moving files to the destination folder' : 'Deleting files'} · please wait…</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'empty') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">{TITLE[mode]}</Text>
        <Box marginTop={1}>
          <Text dimColor>No files with "screenshot" in the name were found. Nothing to do.</Text>
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
        <Text bold color="red">{TITLE[mode]} failed</Text>
        <Box marginTop={1}>
          <Text color="red">{state.errorMsg ?? 'Unknown error'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[q/Esc] back   [h] home</Text>
        </Box>
      </Box>
    );
  }

  if (state.phase === 'results') {
    // mode === 'find': the scan pass IS the whole action.
    const totals = state.scanTotals;
    const sample = state.scanMatches.slice(0, MAX_FILE_ROWS);
    return (
      <Box borderStyle={BOX_BORDER} borderColor="green" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="green">{TITLE[mode]} — Results</Text>
        <Box marginTop={1}>
          <Text>
            <Text color="green">{totals?.matched ?? 0}</Text> screenshot(s) found —{' '}
            <Text color="cyan">{formatBytes(totals?.bytes ?? 0)}</Text> total
          </Text>
        </Box>
        {sample.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            {sample.map((m) => (
              <Text key={m.filePath}>
                {'  '}{m.filePath}  <Text dimColor>({formatBytes(m.size)})</Text>
              </Text>
            ))}
            {(totals?.matched ?? 0) > sample.length && (
              <Text dimColor>  … and {(totals?.matched ?? 0) - sample.length} more</Text>
            )}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>[q/Esc] back   [h] home</Text>
        </Box>
      </Box>
    );
  }

  // done phase (mode 'move' or 'delete', after the real pass)
  const totals = state.finalTotals;
  return (
    <Box borderStyle={BOX_BORDER} borderColor="green" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="green">{TITLE[mode]} complete</Text>
      <Box marginTop={1} flexDirection="column">
        {mode === 'move' && (
          <>
            <Text><Text color="green">{totals?.moved ?? 0}</Text> moved</Text>
            <Text><Text color="blue">{totals?.skipped ?? 0}</Text> skipped (already in place)</Text>
          </>
        )}
        {mode === 'delete' && (
          <Text><Text color="green">{totals?.deleted ?? 0}</Text> deleted</Text>
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
