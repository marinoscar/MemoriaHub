/**
 * tui/StatusScreen.tsx — Read-only status overview screen.
 *
 * Shows a per-folder table with file counts, then lets the user toggle to
 * a recent-runs view with [r].
 *
 * Props: { db, onBack }
 * Keys:
 *   r       — toggle between folders view and runs view
 *   Esc/q   — go back to home
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type BetterSqlite3 from 'better-sqlite3';

import { FolderRepo } from '../repo/folders.js';
import { FileRepo } from '../repo/files.js';
import { RunRepo } from '../repo/runs.js';
import type { Folder } from '../db/types.js';
import type { FileCounts } from '../db/types.js';
import type { SyncRun } from '../db/types.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusScreenProps {
  db: BetterSqlite3.Database;
  onBack: () => void;
}

type View = 'folders' | 'runs';

interface FolderWithCounts {
  folder: Folder;
  counts: FileCounts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncatePath(p: string, max = 36): string {
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso.slice(0, 16);
  }
}

function formatShortDate(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso.slice(0, 16);
  }
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return 'running…';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Folders view
// ---------------------------------------------------------------------------

interface FoldersViewProps {
  rows: FolderWithCounts[];
}

function FoldersView({ rows }: FoldersViewProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>
          No folders registered — choose Manage folders to add one.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header row */}
      <Box flexDirection="row">
        <Text bold dimColor>{'ID'.padEnd(5)}</Text>
        <Text bold dimColor>{'Path'.padEnd(38)}</Text>
        <Text bold dimColor>{'En'.padEnd(4)}</Text>
        <Text bold dimColor>{'Last sync'.padEnd(18)}</Text>
        <Text bold dimColor>{'Up'.padEnd(6)}</Text>
        <Text bold dimColor>{'Queued'.padEnd(8)}</Text>
        <Text bold dimColor>{'Failed'.padEnd(8)}</Text>
        <Text bold dimColor>{'Skip'.padEnd(6)}</Text>
      </Box>

      {rows.map(({ folder: f, counts: c }) => (
        <Box key={f.id} flexDirection="row">
          <Text dimColor>{String(f.id).padEnd(5)}</Text>
          <Text>{truncatePath(f.path, 36).padEnd(38)}</Text>
          <Text color={f.enabled ? 'green' : 'red'}>
            {f.enabled ? 'on' : 'off'}{'  '}
          </Text>
          <Text dimColor>{formatDate(f.last_sync_at).padEnd(18)}</Text>
          <Text color="green">{String(c.uploaded).padEnd(6)}</Text>
          <Text dimColor>{String(c.queued + c.uploading).padEnd(8)}</Text>
          <Text color={c.failed > 0 ? 'red' : undefined} dimColor={c.failed === 0}>
            {String(c.failed).padEnd(8)}
          </Text>
          <Text dimColor>{String(c.skipped).padEnd(6)}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Runs view
// ---------------------------------------------------------------------------

interface RunsViewProps {
  runs: SyncRun[];
}

function RunsView({ runs }: RunsViewProps): React.ReactElement {
  if (runs.length === 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>No sync runs recorded yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header row */}
      <Box flexDirection="row">
        <Text bold dimColor>{'Started'.padEnd(16)}</Text>
        <Text bold dimColor>{'Trigger'.padEnd(10)}</Text>
        <Text bold dimColor>{'Dur'.padEnd(8)}</Text>
        <Text bold dimColor>{'Up'.padEnd(6)}</Text>
        <Text bold dimColor>{'Skip'.padEnd(6)}</Text>
        <Text bold dimColor>{'Fail'.padEnd(6)}</Text>
        <Text bold dimColor>{'Dry'.padEnd(4)}</Text>
      </Box>

      {runs.map((run) => (
        <Box key={run.id} flexDirection="row">
          <Text dimColor>{formatShortDate(run.started_at).padEnd(16)}</Text>
          <Text>{run.trigger.padEnd(10)}</Text>
          <Text dimColor>{formatDuration(run.started_at, run.finished_at).padEnd(8)}</Text>
          <Text color="green">{String(run.uploaded).padEnd(6)}</Text>
          <Text dimColor>{String(run.skipped).padEnd(6)}</Text>
          <Text color={run.failed > 0 ? 'red' : undefined} dimColor={run.failed === 0}>
            {String(run.failed).padEnd(6)}
          </Text>
          <Text dimColor>{run.dry_run ? 'yes' : 'no '} </Text>
        </Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// StatusScreen
// ---------------------------------------------------------------------------

export function StatusScreen({ db, onBack }: StatusScreenProps): React.ReactElement {
  const [view, setView] = useState<View>('folders');

  // Load data synchronously — better-sqlite3 is sync; recomputed when view toggles.
  const folderRows = useMemo<FolderWithCounts[]>(() => {
    const folderRepo = new FolderRepo(db);
    const fileRepo   = new FileRepo(db);
    return folderRepo.list().map((folder) => ({
      folder,
      counts: fileRepo.counts([folder.id]),
    }));
  // Recompute each time view changes so data is fresh when toggling back.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, view]);

  const runs = useMemo<SyncRun[]>(() => {
    if (view !== 'runs') return [];
    return new RunRepo(db).listRuns(10);
  }, [db, view]);

  useInput((input, key) => {
    if (key.escape || input === 'q') { onBack(); return; }
    if (input === 'r') {
      setView((v) => (v === 'folders' ? 'runs' : 'folders'));
      return;
    }
  });

  const title = view === 'folders'
    ? `MemoriaHub — Status (${folderRows.length} folder${folderRows.length !== 1 ? 's' : ''})`
    : 'MemoriaHub — Status (Recent Runs)';

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">{title}</Text>

      {view === 'folders' ? (
        <FoldersView rows={folderRows} />
      ) : (
        <RunsView runs={runs} />
      )}

      <Box marginTop={1}>
        <Text dimColor>
          [r] {view === 'folders' ? 'show runs' : 'show folders'}
          {'  '}[Esc/q] back
        </Text>
      </Box>
    </Box>
  );
}
