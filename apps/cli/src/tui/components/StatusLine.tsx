/**
 * tui/components/StatusLine.tsx — Header status bar for the sync dashboard.
 *
 * Shows: server URL · folder count · elapsed timer · running/done state.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface StatusLineProps {
  serverUrl: string;
  folderCount: number;
  isDone: boolean;
  durationMs?: number;
  title?: string;
}

export function StatusLine({
  serverUrl,
  folderCount,
  isDone,
  durationMs,
  title = 'Sync',
}: StatusLineProps): React.ReactElement {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isDone) return;
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isDone]);

  const elapsedStr = isDone && durationMs !== undefined
    ? `${(durationMs / 1000).toFixed(1)}s`
    : `${elapsed}s`;

  return (
    <Box flexDirection="row" gap={2} paddingX={1}>
      <Text bold color="cyan">MemoriaHub {title}</Text>
      <Text dimColor>│</Text>
      <Text dimColor>{serverUrl}</Text>
      <Text dimColor>│</Text>
      <Text>{folderCount} folder{folderCount !== 1 ? 's' : ''}</Text>
      <Text dimColor>│</Text>
      <Text dimColor>elapsed: {elapsedStr}</Text>
      <Text dimColor>│</Text>
      {isDone ? (
        <Text color="green">done</Text>
      ) : (
        <Box flexDirection="row" gap={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text color="cyan">syncing</Text>
        </Box>
      )}
    </Box>
  );
}
