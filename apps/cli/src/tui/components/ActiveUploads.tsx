/**
 * tui/components/ActiveUploads.tsx — Live per-file upload progress rows.
 *
 * Shows the currently-uploading files (capped at 5) each with a filename,
 * a block-character progress bar, and a percentage.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveFile {
  fileId: number;
  path: string;
  fraction: number; // 0..1
}

interface ActiveUploadsProps {
  files: ActiveFile[];
  maxVisible?: number;
}

// ---------------------------------------------------------------------------
// Mini progress bar
// ---------------------------------------------------------------------------

const BAR_WIDTH = 20;

function miniBar(fraction: number): string {
  const filled = Math.round(fraction * BAR_WIDTH);
  const empty  = BAR_WIDTH - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActiveUploads({
  files,
  maxVisible = 5,
}: ActiveUploadsProps): React.ReactElement | null {
  if (files.length === 0) return null;

  const visible = files.slice(0, maxVisible);

  return (
    <Box flexDirection="column">
      <Text bold dimColor>Active uploads ({files.length})</Text>
      {visible.map((f) => {
        const pct = Math.round(f.fraction * 100);
        const bar = miniBar(f.fraction);
        const name = truncate(basename(f.path), 32);
        return (
          <Box key={f.fileId} flexDirection="row" gap={1}>
            <Text color="cyan">{colors.uploading(bar)}</Text>
            <Text dimColor>{pct.toString().padStart(3)}%</Text>
            <Text>{name}</Text>
          </Box>
        );
      })}
      {files.length > maxVisible && (
        <Text dimColor>  … and {files.length - maxVisible} more</Text>
      )}
    </Box>
  );
}
