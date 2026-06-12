/**
 * tui/SettingsScreen.tsx — Interactive settings editor.
 *
 * Lists known settings with current values, lets the user select one to edit,
 * validates the input, and persists via SettingsRepo.
 *
 * Props: { db, onBack }
 *
 * Steps:
 *   'list'  — navigate/select a setting; Esc/q → onBack()
 *   'edit'  — inline text input; Enter to save, Esc to cancel (stay on screen)
 *
 * Known settings: concurrency (default 3), attempts_cap (default 5).
 * Both must be positive integers (≥ 1).
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type BetterSqlite3 from 'better-sqlite3';

import { SettingsRepo } from '../repo/settings.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Known settings definition
// ---------------------------------------------------------------------------

interface SettingDef {
  key: string;
  default: number;
  description: string;
}

const KNOWN_SETTINGS: SettingDef[] = [
  {
    key: 'concurrency',
    default: 3,
    description: 'Max concurrent upload workers',
  },
  {
    key: 'attempts_cap',
    default: 5,
    description: 'Max upload attempts before a file is blocked',
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SettingsScreenProps {
  db: BetterSqlite3.Database;
  onBack: () => void;
}

type Step = 'list' | 'edit';

interface SelectItem {
  label: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadValues(repo: SettingsRepo): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of KNOWN_SETTINGS) {
    out[s.key] = repo.get<number>(s.key, s.default);
  }
  return out;
}

function buildItems(values: Record<string, number>): SelectItem[] {
  return KNOWN_SETTINGS.map((s) => ({
    label: `${s.key.padEnd(16)} = ${String(values[s.key]).padEnd(4)}  (default: ${s.default})  ${s.description}`,
    value: s.key,
  }));
}

// ---------------------------------------------------------------------------
// SettingsScreen
// ---------------------------------------------------------------------------

export function SettingsScreen({ db, onBack }: SettingsScreenProps): React.ReactElement {
  const repo = new SettingsRepo(db);

  const [step, setStep]           = useState<Step>('list');
  const [values, setValues]       = useState<Record<string, number>>(() => loadValues(repo));
  const [editingKey, setEditingKey] = useState<string>('');
  const [inputVal, setInputVal]   = useState<string>('');
  const [errorMsg, setErrorMsg]   = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');

  // ---- List-step key handler (Esc/q only — SelectInput handles arrows+Enter) ----
  useInput((input, key) => {
    if (step !== 'list') return;
    if (key.escape || input === 'q') { onBack(); return; }
    // Clear transient messages on any keypress
    setSuccessMsg('');
    setErrorMsg('');
  });

  // ---- SelectInput: user chose a setting to edit ----
  const handleSelect = useCallback((item: SelectItem) => {
    const key = item.value;
    setEditingKey(key);
    setInputVal(String(values[key] ?? ''));
    setErrorMsg('');
    setSuccessMsg('');
    setStep('edit');
  }, [values]);

  // ---- TextInput: user submitted the new value ----
  const handleSubmit = useCallback((raw: string) => {
    const trimmed = raw.trim();
    const n = parseInt(trimmed, 10);

    if (isNaN(n) || n < 1 || String(n) !== trimmed) {
      setErrorMsg(`Must be a positive integer (got: "${trimmed}")`);
      // Keep edit step open with the bad value still shown
      return;
    }

    repo.set(editingKey, n);
    const refreshed = loadValues(repo);
    setValues(refreshed);
    setSuccessMsg(`Saved: ${editingKey} = ${n}`);
    setErrorMsg('');
    setStep('list');
  }, [editingKey, repo]);

  // ---- Esc while editing: cancel without saving ----
  useInput((_input, key) => {
    if (step !== 'edit') return;
    if (key.escape) {
      setErrorMsg('');
      setStep('list');
    }
  });

  // ---- List view ----
  if (step === 'list') {
    const items = buildItems(values);

    return (
      <Box
        borderStyle={BOX_BORDER}
        borderColor="cyan"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color="cyan">MemoriaHub — Settings</Text>
        <Text dimColor>Select a setting to edit its value.</Text>

        <Box marginTop={1}>
          <SelectInput items={items} onSelect={handleSelect} />
        </Box>

        {successMsg ? (
          <Box marginTop={1}>
            <Text color="green">✔ {successMsg}</Text>
          </Box>
        ) : null}

        {errorMsg ? (
          <Box marginTop={1}>
            <Text color="red">✖ {errorMsg}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text dimColor>[up/down] navigate  [Enter] edit  [Esc/q] back</Text>
        </Box>
      </Box>
    );
  }

  // ---- Edit view ----
  const def = KNOWN_SETTINGS.find((s) => s.key === editingKey);

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">MemoriaHub — Settings</Text>
      <Text> </Text>
      <Text bold>Editing: <Text color="cyan">{editingKey}</Text></Text>
      {def ? <Text dimColor>{def.description}  (default: {def.default})</Text> : null}

      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text dimColor>New value:</Text>
        <TextInput
          value={inputVal}
          onChange={(v) => { setInputVal(v); setErrorMsg(''); }}
          onSubmit={handleSubmit}
          placeholder={String(def?.default ?? '')}
        />
      </Box>

      {errorMsg ? (
        <Box marginTop={1}>
          <Text color="red">✖ {errorMsg}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>[Enter] save  [Esc] cancel</Text>
      </Box>
    </Box>
  );
}
