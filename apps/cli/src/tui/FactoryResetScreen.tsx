/**
 * tui/FactoryResetScreen.tsx — Destructive factory-reset confirmation screen.
 *
 * Explicitly lists what will be erased and requires the user to type "y"
 * then press Enter before proceeding.  Esc always cancels.
 *
 * Props:
 *   onConfirm — called after the user confirms; caller performs the actual reset.
 *   onCancel  — called when the user cancels (Esc or any non-"y" submit).
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FactoryResetScreenProps {
  onConfirm: () => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FactoryResetScreen({
  onConfirm,
  onCancel,
}: FactoryResetScreenProps): React.ReactElement {
  // Controlled input — bound to real state so the user can actually type.
  const [confirmText, setConfirmText] = useState('');

  // Esc always cancels, even mid-type.
  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  function handleSubmit(value: string): void {
    if (value.trim().toLowerCase() === 'y') {
      onConfirm();
    } else {
      onCancel();
    }
  }

  return (
    <Box borderStyle={BOX_BORDER} borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="red">Factory Reset — Delete All Local Data</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color="red">The following will be permanently deleted:</Text>
        <Text>  • Server URL and login token (PAT)</Text>
        <Text>  • All managed folders</Text>
        <Text>  • All upload history and sync runs</Text>
        <Text>  • All settings</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold color="red">This action is irreversible. You will need to log in again.</Text>
      </Box>

      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text dimColor>Type y then Enter to confirm, or Esc to cancel:</Text>
        <TextInput
          value={confirmText}
          onChange={setConfirmText}
          onSubmit={handleSubmit}
          placeholder="n"
        />
      </Box>
    </Box>
  );
}
