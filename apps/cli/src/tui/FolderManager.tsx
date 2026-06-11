/**
 * tui/FolderManager.tsx — Interactive folder registry manager.
 *
 * Lists registered folders, lets the user:
 *   a — Add new folder (path + recursive y/n)
 *   e — Enable/disable toggle on selected row
 *   d — Remove selected (with confirm)
 *   up/down — navigate rows
 *   Esc/q — back to home
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type BetterSqlite3 from 'better-sqlite3';

import { FolderRepo } from '../repo/folders.js';
import type { Folder } from '../db/types.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubScreen = 'list' | 'add-path' | 'add-recursive' | 'confirm-remove';

interface FolderManagerProps {
  db: BetterSqlite3.Database;
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncatePath(p: string, max = 40): string {
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: '2-digit',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FolderManager({ db, onBack }: FolderManagerProps): React.ReactElement {
  const repo = new FolderRepo(db);

  const [folders, setFolders]       = useState<Folder[]>(() => repo.list());
  const [selected, setSelected]     = useState(0);
  const [subScreen, setSubScreen]   = useState<SubScreen>('list');
  const [newPath, setNewPath]       = useState('');
  const [newRecursive, setNewRecursive] = useState('');
  const [statusMsg, setStatusMsg]   = useState('');
  const [errorMsg, setErrorMsg]     = useState('');

  const refresh = useCallback(() => {
    const updated = repo.list();
    setFolders(updated);
    setSelected((s) => Math.min(s, Math.max(0, updated.length - 1)));
  }, [repo]);

  useInput((input, key) => {
    if (subScreen !== 'list') return;

    if (key.escape || input === 'q') { onBack(); return; }

    if (key.upArrow)   { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSelected((s) => Math.min(folders.length - 1, s + 1)); return; }

    if (input === 'a') {
      setNewPath('');
      setNewRecursive('');
      setErrorMsg('');
      setSubScreen('add-path');
      return;
    }

    if (input === 'e' && folders.length > 0) {
      const f = folders[selected];
      if (!f) return;
      try {
        repo.setEnabled(f.id, !f.enabled);
        refresh();
        setStatusMsg(`Folder ${f.enabled ? 'disabled' : 'enabled'}.`);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (input === 'd' && folders.length > 0) {
      setSubScreen('confirm-remove');
      return;
    }

    setStatusMsg('');
    setErrorMsg('');
  });

  function handleAddPathSubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) { setSubScreen('list'); return; }
    setNewPath(trimmed);
    setNewRecursive('');
    setSubScreen('add-recursive');
  }

  function handleRecursiveSubmit(value: string): void {
    const v = value.trim().toLowerCase();
    const recursive = v === 'y' || v === 'yes';
    try {
      repo.add({ path: newPath, recursive });
      refresh();
      setStatusMsg(`Added: ${newPath} (recursive: ${recursive ? 'yes' : 'no'})`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
    setSubScreen('list');
  }

  function handleConfirmRemove(value: string): void {
    const v = value.trim().toLowerCase();
    setSubScreen('list');
    if (v !== 'y' && v !== 'yes') {
      setStatusMsg('Remove cancelled.');
      return;
    }
    const f = folders[selected];
    if (!f) return;
    try {
      repo.remove(f.id);
      refresh();
      setStatusMsg(`Removed folder: ${f.path}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Render sub-screens ----
  if (subScreen === 'add-path') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Add Folder</Text>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text dimColor>Path:</Text>
          <TextInput
            value={newPath}
            onChange={setNewPath}
            onSubmit={handleAddPathSubmit}
            placeholder="/home/user/Photos"
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Enter] confirm  [leave empty + Enter to cancel]</Text>
        </Box>
      </Box>
    );
  }

  if (subScreen === 'add-recursive') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Add Folder — {newPath}</Text>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text dimColor>Scan subdirectories recursively? [y/n]:</Text>
          <TextInput
            value={newRecursive}
            onChange={setNewRecursive}
            onSubmit={handleRecursiveSubmit}
            placeholder="n"
          />
        </Box>
      </Box>
    );
  }

  if (subScreen === 'confirm-remove') {
    const f = folders[selected];
    return (
      <Box borderStyle={BOX_BORDER} borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="red">Remove Folder?</Text>
        <Box marginTop={1}>
          <Text>{f?.path ?? '(none)'}</Text>
        </Box>
        <Text dimColor>This removes all file records for this folder from the DB.</Text>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text dimColor>Confirm [y/n]:</Text>
          <TextInput value="" onChange={() => {}} onSubmit={handleConfirmRemove} placeholder="n" />
        </Box>
      </Box>
    );
  }

  // ---- Main list ----
  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Managed Folders ({folders.length})</Text>

      {folders.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No folders registered. Press [a] to add one.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {/* Header row */}
          <Box flexDirection="row" gap={1}>
            <Text bold dimColor>{' '.padEnd(2)}</Text>
            <Text bold dimColor>{'ID'.padEnd(4)}</Text>
            <Text bold dimColor>{'Path'.padEnd(42)}</Text>
            <Text bold dimColor>{'Rec'.padEnd(4)}</Text>
            <Text bold dimColor>{'En'.padEnd(4)}</Text>
            <Text bold dimColor>{'Last Sync'.padEnd(12)}</Text>
          </Box>
          {folders.map((f, i) => {
            const isSelected = i === selected;
            return (
              <Box key={f.id} flexDirection="row" gap={1}>
                <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶' : ' '} </Text>
                <Text color={isSelected ? 'cyanBright' : undefined}>{String(f.id).padEnd(4)}</Text>
                <Text color={isSelected ? 'cyanBright' : undefined}>{truncatePath(f.path, 40).padEnd(42)}</Text>
                <Text color={f.recursive ? 'cyan' : undefined} dimColor={!f.recursive}>
                  {f.recursive ? 'yes' : 'no '}{'  '}
                </Text>
                <Text color={f.enabled ? 'green' : 'red'}>
                  {f.enabled ? 'on' : 'off'}{'  '}
                </Text>
                <Text dimColor>{formatDate(f.last_sync_at)}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Status messages */}
      {statusMsg && (
        <Box marginTop={1}>
          <Text color="green">✔ {statusMsg}</Text>
        </Box>
      )}
      {errorMsg && (
        <Box marginTop={1}>
          <Text color="red">✖ {errorMsg}</Text>
        </Box>
      )}

      {/* Key hints */}
      <Box flexDirection="row" gap={3} marginTop={1}>
        <Text dimColor>[a] add</Text>
        <Text dimColor>[e] toggle enable</Text>
        <Text dimColor>[d] remove</Text>
        <Text dimColor>[up/down] select</Text>
        <Text dimColor>[q/Esc] back</Text>
      </Box>
    </Box>
  );
}
