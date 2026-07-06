/**
 * tui/ConvertFileInput.tsx — Single-file path entry for the Convert flow.
 *
 * Prompts for one video file path, validates it exists and is a file on submit,
 * then calls onConfirm(absPath) — the app routes that to a ConvertScreen scoped
 * to the single file.  Esc or an empty submit cancels back.  Kept intentionally
 * small: a text prompt, mirroring the lightweight input screens elsewhere in
 * tui/ (e.g. FolderManager's add-path prompt).
 */

import React, { useState } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { isConvertibleVideo } from '../convert/plan.js';
import { BOX_BORDER } from './theme.js';

export interface ConvertFileInputProps {
  onConfirm: (absPath: string) => void;
  onBack: () => void;
}

export function ConvertFileInput({
  onConfirm,
  onBack,
}: ConvertFileInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useInput((_input, key) => {
    if (key.escape) onBack();
  });

  const handleSubmit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      onBack();
      return;
    }
    const abs = path.resolve(trimmed);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      setErrorMsg(`Path not found: ${abs}`);
      return;
    }
    if (!stat.isFile()) {
      setErrorMsg('That path is a folder — use "Convert selected folder(s)" instead.');
      return;
    }
    if (!isConvertibleVideo(abs)) {
      setErrorMsg('Not a convertible video file (MOV, MTS, AVI, WMV, …).');
      return;
    }
    onConfirm(abs);
  };

  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Convert a Single File</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Enter the path to a video file to convert to MP4:</Text>
        <Box marginTop={1}>
          <Text color="cyan">{'› '}</Text>
          <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
        </Box>
      </Box>
      {errorMsg.length > 0 && (
        <Box marginTop={1}>
          <Text color="red">{errorMsg}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>[Enter] continue   [Esc] cancel</Text>
      </Box>
    </Box>
  );
}
