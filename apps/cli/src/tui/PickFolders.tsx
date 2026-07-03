/**
 * tui/PickFolders.tsx — Multi-select folder picker for "Sync selected".
 *
 * Shows enabled folders with [x]/[ ] checkboxes.
 *   Space   — toggle selection
 *   Enter   — confirm (passes selected folderIds to onConfirm)
 *   Esc/q   — cancel, back to home
 *   up/down — navigate
 *   a       — select all
 *   n       — select none
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type BetterSqlite3 from 'better-sqlite3';

import { FolderRepo } from '../repo/folders.js';
import type { Folder } from '../db/types.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PickFoldersProps {
  db: BetterSqlite3.Database;
  onConfirm: (folderIds: number[]) => void;
  onBack: () => void;
  /** Heading shown at the top of the picker. Defaults to the sync wording. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncatePath(p: string, max = 50): string {
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PickFolders({ db, onConfirm, onBack, title }: PickFoldersProps): React.ReactElement {
  const heading = title ?? 'Sync Selected Folders';
  const repo = new FolderRepo(db);
  const [folders] = useState<Folder[]>(() => repo.list({ enabledOnly: true }));
  const [cursor, setCursor]   = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  useInput((input, key) => {
    if (key.escape || input === 'q') { onBack(); return; }

    if (key.upArrow)   { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(folders.length - 1, c + 1)); return; }

    if (input === ' ') {
      const f = folders[cursor];
      if (!f) return;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(f.id)) { next.delete(f.id); } else { next.add(f.id); }
        return next;
      });
      return;
    }

    if (key.return) {
      const selected = [...checked];
      if (selected.length === 0) return;
      onConfirm(selected);
      return;
    }

    if (input === 'a') {
      setChecked(new Set(folders.map((f) => f.id)));
      return;
    }

    if (input === 'n') {
      setChecked(new Set());
      return;
    }
  });

  if (folders.length === 0) {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">{heading}</Text>
        <Box marginTop={1}>
          <Text dimColor>No enabled folders found. Use Manage Folders to add and enable folders first.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Esc/q] back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{heading}</Text>
      <Text dimColor>Space to toggle, Enter to confirm</Text>

      <Box flexDirection="column" marginTop={1}>
        {folders.map((f, i) => {
          const isCursor = i === cursor;
          const isChecked = checked.has(f.id);
          return (
            <Box key={f.id} flexDirection="row" gap={1}>
              <Text color={isCursor ? 'cyan' : undefined}>{isCursor ? '▶' : ' '}</Text>
              <Text color={isChecked ? 'green' : undefined}>{isChecked ? '[x]' : '[ ]'}</Text>
              <Text color={isCursor ? 'cyanBright' : undefined}>
                {truncatePath(f.path, 50)}
              </Text>
              {f.last_sync_at && (
                <Text dimColor>  (last: {f.last_sync_at.slice(0, 10)})</Text>
              )}
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="row" gap={2} marginTop={1}>
        <Text dimColor>[Space] toggle  [Enter] sync ({checked.size} selected)</Text>
        <Text dimColor>[a] all  [n] none  [q/Esc] back</Text>
      </Box>
    </Box>
  );
}
