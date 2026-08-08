/**
 * tui/BackupScreen.tsx — Backup placeholder screen.
 *
 * The v0 blob-pull backup (runBackup engine) was removed in issue #314 in
 * favor of the node-based local backup. `memoriahub backup init` prepares a
 * backup root today; the sync engine (`backup run`) lands in the next release,
 * at which point this screen becomes the guided backup flow again.
 *
 * Props: { config, onBack }
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';

import type { CliConfig } from '../config.js';
import { BOX_BORDER } from './theme.js';

interface BackupScreenProps {
  config: CliConfig;
  onBack: () => void;
}

export function BackupScreen({ config: _config, onBack }: BackupScreenProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'q' || key.return) onBack();
  });

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">MemoriaHub — Backup</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>
          Local backup is moving to worker nodes. Prepare a backup root with:
        </Text>
        <Box marginTop={1}>
          <Text color="cyan">  memoriahub backup init --dest &lt;dir&gt;</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            The sync engine (`memoriahub backup run`) lands in the next release.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Esc/q/Enter] back</Text>
        </Box>
      </Box>
    </Box>
  );
}
