/**
 * tui/LoginScreen.tsx — Interactive login screen for the TUI.
 *
 * Prompts for server URL then PAT (masked), validates via GET /api/auth/me,
 * saves config on success, shows error on failure, returns to home.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { ApiClient } from '../api.js';
import { saveConfig, type CliConfig } from '../config.js';
import { BOX_BORDER, primary, success, error as errorColor } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 'url' | 'pat' | 'validating' | 'success' | 'error';

interface LoginScreenProps {
  initialConfig: CliConfig | null;
  onDone: (cfg: CliConfig) => void;
  onBack: () => void;
}

interface MeResponse {
  email?: string;
  displayName?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LoginScreen({
  initialConfig,
  onDone,
  onBack,
}: LoginScreenProps): React.ReactElement {
  const [step, setStep]         = useState<Step>('url');
  const [serverUrl, setServerUrl] = useState(initialConfig?.serverUrl ?? '');
  const [pat, setPat]           = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [identity, setIdentity] = useState('');

  useInput((_input, key) => {
    if (key.escape && step !== 'validating') {
      onBack();
    }
  });

  // URL confirmed — move to PAT entry
  function handleUrlSubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    setServerUrl(trimmed);
    setStep('pat');
  }

  // PAT confirmed — validate
  async function handlePatSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    setPat(trimmed);
    setStep('validating');

    const cfg: CliConfig = { serverUrl: serverUrl.replace(/\/$/, ''), pat: trimmed };
    try {
      const api = new ApiClient(cfg);
      const me = await api.get<MeResponse>('/api/auth/me');
      const email = me.email ?? 'unknown';
      saveConfig(cfg);
      setIdentity(email);
      setStep('success');
      // Transition to home after brief success display
      setTimeout(() => onDone(cfg), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setStep('error');
    }
  }

  const maskedPat = pat ? '•'.repeat(Math.min(pat.length, 20)) : '';

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={3}
      paddingY={2}
    >
      <Text bold color="cyan">MemoriaHub — Login</Text>
      <Text> </Text>

      {/* URL input */}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Server URL:</Text>
        {step === 'url' ? (
          <TextInput
            value={serverUrl}
            onChange={setServerUrl}
            onSubmit={handleUrlSubmit}
            placeholder="https://your.memoriahub.server"
          />
        ) : (
          <Text color="cyan">{serverUrl}</Text>
        )}
      </Box>

      {/* PAT input */}
      {(step === 'pat' || step === 'validating' || step === 'success' || step === 'error') && (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text dimColor>Personal Access Token:</Text>
          {step === 'pat' ? (
            <TextInput
              value={pat}
              onChange={setPat}
              onSubmit={(v) => { void handlePatSubmit(v); }}
              mask="•"
              placeholder="paste your PAT here"
            />
          ) : (
            <Text dimColor>{maskedPat || '•••'}</Text>
          )}
        </Box>
      )}

      {/* Status */}
      {step === 'validating' && (
        <Box marginTop={1}>
          <Text color="cyan">Verifying credentials…</Text>
        </Box>
      )}

      {step === 'success' && (
        <Box marginTop={1}>
          <Text color="green">{success('✔')} Logged in as {identity}</Text>
        </Box>
      )}

      {step === 'error' && (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Text color="red">{errorColor('✖')} {errorMsg}</Text>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Press</Text>
            <Text color="cyan">Esc</Text>
            <Text dimColor>to go back, or re-enter your PAT:</Text>
          </Box>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text dimColor>Personal Access Token:</Text>
            <TextInput
              value={pat}
              onChange={setPat}
              onSubmit={(v) => { void handlePatSubmit(v); }}
              mask="•"
              placeholder="retry PAT"
            />
          </Box>
        </Box>
      )}

      {/* Hints */}
      {(step === 'url' || step === 'pat') && (
        <Box marginTop={2}>
          <Text dimColor>[Esc] cancel  [Enter] confirm</Text>
        </Box>
      )}
      {/* Unused but intentional: suppress primary/errorColor import warnings */}
      {false && <Text>{primary('')}{errorColor('')}</Text>}
    </Box>
  );
}
