/**
 * tui/BackupScreen.tsx — Guided backup flow (scope → destination → run).
 *
 * Wraps the presentation-free `runBackup` engine in a small three-step Ink
 * flow. Esc/q leaves at any step (an in-flight backup is allowed to settle in
 * the background). Matches the standard cyan bordered style.
 *
 * Props: { config, onBack }
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import * as os from 'os';
import * as path from 'path';

import { ApiClient } from '../api.js';
import type { CliConfig } from '../config.js';
import { runBackup, type BackupProgress, type BackupResult } from '../backup/run-backup.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackupScreenProps {
  config: CliConfig;
  onBack: () => void;
}

type Step = 'scope' | 'destination' | 'running' | 'done' | 'error';
type Scope = 'circle' | 'all';

interface ScopeItem {
  label: string;
  value: Scope;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULT_DEST = '~/memoriahub-backup';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BackupScreen({ config, onBack }: BackupScreenProps): React.ReactElement {
  const [step, setStep] = useState<Step>('scope');
  const [scope, setScope] = useState<Scope>('all');
  const [dest, setDest] = useState<string>(DEFAULT_DEST);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  // Esc/q leaves at any step.
  useInput((input, key) => {
    if (key.escape || input === 'q') onBack();
  });

  // Kick off the backup when we enter the running step.
  useEffect(() => {
    if (step !== 'running') return;

    let cancelled = false;
    const absDest = expandHome(dest.trim() || DEFAULT_DEST);

    void (async () => {
      try {
        const api = new ApiClient(config);
        const res = await runBackup(
          api,
          {
            circle: scope === 'circle' ? config.activeCircleId : undefined,
            all: scope === 'all',
            dest: absDest,
          },
          (p) => {
            if (!cancelled) setProgress(p);
          },
        );
        if (cancelled) return;
        setResult(res);
        setStep('done');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // -------------------------------------------------------------------------
  // Scope options
  // -------------------------------------------------------------------------

  const scopeItems: ScopeItem[] = [];
  if (config.activeCircleId) {
    scopeItems.push({ label: 'Active circle', value: 'circle' });
  }
  scopeItems.push({ label: 'All circles', value: 'all' });

  function handleScopeSelect(item: ScopeItem): void {
    setScope(item.value);
    setStep('destination');
  }

  function handleDestSubmit(): void {
    if (!dest.trim()) setDest(DEFAULT_DEST);
    setStep('running');
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">MemoriaHub — Backup</Text>

      {/* Step 1: scope */}
      {step === 'scope' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Choose what to back up:</Text>
          <Box marginTop={1}>
            <SelectInput items={scopeItems} onSelect={handleScopeSelect} />
          </Box>
        </Box>
      )}

      {/* Step 2: destination */}
      {step === 'destination' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Scope: <Text color="cyan">{scope === 'all' ? 'All circles' : 'Active circle'}</Text></Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text dimColor>Destination:</Text>
            <TextInput value={dest} onChange={setDest} onSubmit={handleDestSubmit} />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>[Enter] start backup   [Esc] cancel</Text>
          </Box>
        </Box>
      )}

      {/* Step 3: running */}
      {step === 'running' && (
        <Box flexDirection="column" marginTop={1}>
          {progress ? (
            <>
              <Text>
                <Text color="cyan">{progress.phase}</Text>
                {'  '}
                <Text color="green">{progress.downloaded}</Text>
                {' downloaded · '}
                <Text color="blue">{progress.skipped}</Text>
                {' skipped · '}
                <Text color={progress.failed > 0 ? 'red' : 'white'}>{progress.failed}</Text>
                {' failed'}
                {progress.total > 0 && <Text dimColor>{`  of ${progress.total}`}</Text>}
              </Text>
              {progress.current && (
                <Text dimColor>{`→ ${progress.current}`}</Text>
              )}
            </>
          ) : (
            <Text dimColor>Starting…</Text>
          )}
        </Box>
      )}

      {/* Step 4: done */}
      {step === 'done' && result && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">
            {`✔ Backup complete — ${result.downloaded} downloaded, ${result.skipped} skipped, ${result.failed} failed (of ${result.total}).`}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>[Esc/q] back</Text>
          </Box>
        </Box>
      )}

      {/* Error */}
      {step === 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">{`✖ ${errorMsg}`}</Text>
          <Box marginTop={1}>
            <Text dimColor>[Esc/q] back</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
