/**
 * tui/NodeConfig.tsx — Ink editor for persisted worker-node settings.
 *
 * Edits the `node` block of the CLI config (concurrency, poll interval, node
 * name, and the eligible job-type set) and persists it via saveConfig(). The
 * server URL is shown read-only (it is changed through Login, not here).
 *
 * Concurrency is special-cased: after persisting to config (so the next
 * `node start` picks it up), if a daemon is currently running we also push
 * `{cmd:'set-concurrency'}` over the IPC socket so the change takes effect on
 * the live process immediately (mirrors `node/daemon.ts`'s `set-concurrency`
 * command, also used by the NodeDashboard config editor). The save message
 * distinguishes "applied live to running daemon" from "will apply on next
 * start" so the operator knows which happened.
 *
 * Two input primitives are used:
 *   - ink-text-input (TextInput) for name / concurrency / poll interval, matching
 *     SettingsScreen's inline-edit pattern.
 *   - a hand-rolled checkbox list (useInput: ↑/↓ move, space toggle, Enter save)
 *     for the multi-select over NODE_JOB_TYPES — the repo ships no multiselect
 *     component, so this mirrors the checkbox convention used elsewhere.
 *
 * Steps:
 *   'menu'        — SelectInput over the editable fields; Esc/q → onBack
 *   'edit-text'   — inline TextInput for a scalar field
 *   'edit-types'  — checkbox list for eligible job types
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';

import { saveConfig, type CliConfig } from '../config.js';
import { NODE_JOB_TYPES } from '../node/capabilities.js';
import { connectToDaemon, isDaemonRunning } from '../node/ipc-client.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Defaults (mirror commands/node.ts)
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 5000;
const DEFAULT_CONCURRENCY = 1;

// ---------------------------------------------------------------------------
// Props + local types
// ---------------------------------------------------------------------------

export interface NodeConfigProps {
  config: CliConfig;
  /** Called with the persisted config after a successful save. */
  onSaved?: (config: CliConfig) => void;
  onBack: () => void;
}

interface Draft {
  name: string;
  concurrency: number;
  pollIntervalMs: number;
  eligibleTypes: string[];
}

type Step = 'menu' | 'edit-text' | 'edit-types';
type ScalarField = 'name' | 'concurrency' | 'poll';

interface SelectItem {
  label: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Push a live concurrency change to a running daemon over the IPC socket.
 * Resolves `true` only when the daemon acknowledged the change; `false` when
 * no daemon is running, the connection failed, or no ack arrived in time —
 * in all of those cases the persisted config value still takes effect on the
 * next `node start`.
 */
async function pushConcurrencyLive(value: number): Promise<boolean> {
  if (!(await isDaemonRunning())) return false;
  let client: Awaited<ReturnType<typeof connectToDaemon>>;
  try {
    client = await connectToDaemon();
  } catch {
    return false;
  }
  try {
    client.send({ cmd: 'set-concurrency', value });
    const ack = await client.waitFor(
      (m) => m.kind === 'ack' && m.cmd === 'set-concurrency',
      2000,
    );
    return ack.kind === 'ack';
  } catch {
    return false;
  } finally {
    client.close();
  }
}

function initialDraft(config: CliConfig): Draft {
  return {
    name: config.node?.name ?? '',
    concurrency: Math.max(1, config.node?.concurrency ?? DEFAULT_CONCURRENCY),
    pollIntervalMs: config.node?.pollIntervalMs ?? DEFAULT_POLL_MS,
    eligibleTypes:
      config.node?.eligibleTypes && config.node.eligibleTypes.length > 0
        ? config.node.eligibleTypes.filter((t) => (NODE_JOB_TYPES as readonly string[]).includes(t))
        : [...NODE_JOB_TYPES],
  };
}

// ---------------------------------------------------------------------------
// NodeConfig component
// ---------------------------------------------------------------------------

export function NodeConfig({ config, onSaved, onBack }: NodeConfigProps): React.ReactElement {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(config));
  const [step, setStep] = useState<Step>('menu');
  const [editingField, setEditingField] = useState<ScalarField>('name');
  const [inputVal, setInputVal] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');

  // Checkbox-list cursor + working selection for the types editor
  const [typeCursor, setTypeCursor] = useState<number>(0);
  const [typeSelection, setTypeSelection] = useState<Set<string>>(new Set());

  // Persist the whole node block and surface the new config upward.
  const persist = useCallback(
    (next: Draft): void => {
      const newConfig: CliConfig = {
        ...config,
        node: {
          name: next.name.trim() || undefined,
          concurrency: next.concurrency,
          pollIntervalMs: next.pollIntervalMs,
          eligibleTypes: next.eligibleTypes,
        },
      };
      saveConfig(newConfig);
      onSaved?.(newConfig);
    },
    [config, onSaved],
  );

  // ---- menu-step keys (Esc/q back; SelectInput owns arrows+Enter) ----
  useInput((input, key) => {
    if (step !== 'menu') return;
    if (key.escape || input === 'q') {
      onBack();
      return;
    }
    setSuccessMsg('');
    setErrorMsg('');
  });

  // ---- checkbox-list keys ----
  useInput((input, key) => {
    if (step !== 'edit-types') return;
    if (key.escape) {
      setErrorMsg('');
      setStep('menu');
      return;
    }
    if (key.upArrow) {
      setTypeCursor((c) => (c - 1 + NODE_JOB_TYPES.length) % NODE_JOB_TYPES.length);
      return;
    }
    if (key.downArrow) {
      setTypeCursor((c) => (c + 1) % NODE_JOB_TYPES.length);
      return;
    }
    if (input === ' ') {
      setTypeSelection((prev) => {
        const next = new Set(prev);
        const t = NODE_JOB_TYPES[typeCursor];
        if (next.has(t)) next.delete(t);
        else next.add(t);
        return next;
      });
      return;
    }
    if (key.return) {
      if (typeSelection.size === 0) {
        setErrorMsg('Select at least one job type (space to toggle).');
        return;
      }
      // Preserve NODE_JOB_TYPES order in the persisted list.
      const ordered = NODE_JOB_TYPES.filter((t) => typeSelection.has(t));
      const next = { ...draft, eligibleTypes: [...ordered] };
      setDraft(next);
      persist(next);
      setSuccessMsg(`Saved eligible types (${ordered.length}/${NODE_JOB_TYPES.length}).`);
      setErrorMsg('');
      setStep('menu');
    }
  });

  // ---- SelectInput: chose a field to edit ----
  const handleSelect = useCallback(
    (item: SelectItem): void => {
      setSuccessMsg('');
      setErrorMsg('');
      switch (item.value) {
        case 'name':
          setEditingField('name');
          setInputVal(draft.name);
          setStep('edit-text');
          break;
        case 'concurrency':
          setEditingField('concurrency');
          setInputVal(String(draft.concurrency));
          setStep('edit-text');
          break;
        case 'poll':
          setEditingField('poll');
          setInputVal(String(draft.pollIntervalMs));
          setStep('edit-text');
          break;
        case 'types':
          setTypeSelection(new Set(draft.eligibleTypes));
          setTypeCursor(0);
          setStep('edit-types');
          break;
        case 'server':
          setErrorMsg('Server URL is read-only here — change it via Login.');
          break;
      }
    },
    [draft],
  );

  // ---- TextInput submit for scalar fields ----
  const handleSubmit = useCallback(
    (raw: string): void => {
      const trimmed = raw.trim();
      if (editingField === 'name') {
        const next = { ...draft, name: trimmed };
        setDraft(next);
        persist(next);
        setSuccessMsg(`Saved name = ${trimmed || '(unnamed)'}`);
        setErrorMsg('');
        setStep('menu');
        return;
      }
      const n = parseInt(trimmed, 10);
      if (editingField === 'concurrency') {
        if (isNaN(n) || n < 1 || n > 64 || String(n) !== trimmed) {
          setErrorMsg(`Concurrency must be an integer between 1 and 64 (got "${trimmed}").`);
          return;
        }
        const next = { ...draft, concurrency: n };
        setDraft(next);
        persist(next);
        setErrorMsg('');
        setStep('menu');
        setSuccessMsg(`Saved concurrency = ${n} (checking for a running daemon…)`);
        void pushConcurrencyLive(n).then((applied) => {
          setSuccessMsg(
            applied
              ? `Saved concurrency = ${n} — applied live to the running daemon.`
              : `Saved concurrency = ${n} — will apply on next \`node start\`.`,
          );
        });
        return;
      }
      // poll
      if (isNaN(n) || n < 250 || String(n) !== trimmed) {
        setErrorMsg(`Poll interval must be an integer ≥ 250 ms (got "${trimmed}").`);
        return;
      }
      const next = { ...draft, pollIntervalMs: n };
      setDraft(next);
      persist(next);
      setSuccessMsg(`Saved poll interval = ${n}ms`);
      setErrorMsg('');
      setStep('menu');
    },
    [draft, editingField, persist],
  );

  // ---- Esc while editing text: cancel ----
  useInput((_input, key) => {
    if (step !== 'edit-text') return;
    if (key.escape) {
      setErrorMsg('');
      setStep('menu');
    }
  });

  // -------------------------------------------------------------------------
  // menu view
  // -------------------------------------------------------------------------
  if (step === 'menu') {
    const serverHost = (() => {
      try {
        return new URL(config.serverUrl).host;
      } catch {
        return config.serverUrl;
      }
    })();

    const items: SelectItem[] = [
      { label: `Node name        = ${draft.name || '(unnamed)'}`, value: 'name' },
      { label: `Concurrency      = ${draft.concurrency}`, value: 'concurrency' },
      { label: `Poll interval    = ${draft.pollIntervalMs} ms`, value: 'poll' },
      {
        label: `Eligible types   = ${draft.eligibleTypes.length}/${NODE_JOB_TYPES.length} selected`,
        value: 'types',
      },
      { label: `Server URL       = ${serverHost}  (read-only)`, value: 'server' },
    ];

    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Configuration</Text>
        <Text dimColor>Select a field to edit. Changes are saved immediately.</Text>

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
          <Text dimColor>[↑/↓] navigate  [Enter] edit  [Esc/q] back</Text>
        </Box>
      </Box>
    );
  }

  // -------------------------------------------------------------------------
  // edit-types view (checkbox list)
  // -------------------------------------------------------------------------
  if (step === 'edit-types') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Eligible Job Types</Text>
        <Text dimColor>Space toggles; Enter saves; Esc cancels.</Text>

        <Box flexDirection="column" marginTop={1}>
          {NODE_JOB_TYPES.map((t, i) => {
            const checked = typeSelection.has(t);
            const isCursor = i === typeCursor;
            return (
              <Box key={t} flexDirection="row" gap={1}>
                <Text color={isCursor ? 'cyan' : undefined}>{isCursor ? '❯' : ' '}</Text>
                <Text color={checked ? 'green' : undefined}>{checked ? '[x]' : '[ ]'}</Text>
                <Text color={isCursor ? 'cyan' : undefined}>{t}</Text>
              </Box>
            );
          })}
        </Box>

        {errorMsg ? (
          <Box marginTop={1}>
            <Text color="red">✖ {errorMsg}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text dimColor>Selected: {typeSelection.size}/{NODE_JOB_TYPES.length}   [↑/↓] move  [space] toggle  [Enter] save  [Esc] cancel</Text>
        </Box>
      </Box>
    );
  }

  // -------------------------------------------------------------------------
  // edit-text view
  // -------------------------------------------------------------------------
  const fieldLabel =
    editingField === 'name'
      ? 'Node name'
      : editingField === 'concurrency'
        ? 'Concurrency'
        : 'Poll interval (ms)';

  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Worker Node — Configuration</Text>
      <Text> </Text>
      <Text bold>Editing: <Text color="cyan">{fieldLabel}</Text></Text>

      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text dimColor>New value:</Text>
        <TextInput
          value={inputVal}
          onChange={(v) => {
            setInputVal(v);
            setErrorMsg('');
          }}
          onSubmit={handleSubmit}
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
