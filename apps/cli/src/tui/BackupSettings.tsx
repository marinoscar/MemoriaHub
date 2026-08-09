/**
 * tui/BackupSettings.tsx — Ink editor for the backup binding + throttle knobs
 * (issue #320, epic #308). Pattern: tui/NodeConfig.tsx.
 *
 * Three groups of settings, each owned by a different layer:
 *
 *   - Root path  — READ-ONLY here. The root is bound by `backup init`, which
 *     also registers/attaches the worker node and creates the catalog; letting
 *     it be retyped in a settings form would silently orphan a catalog.
 *   - Schedule   — SERVER-owned (cron parsing, timezone math and nextRunAt are
 *     all computed server-side), so editing it is a PUT through ApiClient, not
 *     a local write. Offered as presets plus a custom cron entry.
 *   - Rate knobs — LOCAL settings KV (backup.concurrency / backup.maxMbps),
 *     persisted for future runs AND pushed live over IPC when a daemon is
 *     running, exactly like `backup set-rate`.
 *
 * Steps: 'menu' → 'edit-text' (concurrency / max-mbps / custom cron) or
 * 'edit-schedule' (preset list).
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';

import type { CliConfig } from '../config.js';
import { ApiClient, ApiError, type NodeBackupConfig } from '../api.js';
import { getDb } from '../db/database.js';
import { SettingsRepo } from '../repo/settings.js';
import { connectToDaemon, isDaemonRunning } from '../node/ipc-client.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Schedule presets (a custom cron is always available too)
// ---------------------------------------------------------------------------

export interface SchedulePreset {
  label: string;
  cron: string | null;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { label: 'Every night at 03:00', cron: '0 3 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every Sunday at 02:00', cron: '0 2 * * 0' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Disable the schedule', cron: null },
];

// ---------------------------------------------------------------------------
// Live rate push (mirrors commands/backup.ts set-rate)
// ---------------------------------------------------------------------------

/**
 * Push new throttle knobs to a running daemon. Resolves true only when the
 * daemon acknowledged; false means the persisted value still applies from the
 * next run.
 */
export async function pushRateLive(update: {
  concurrency?: number;
  maxMbps?: number;
}): Promise<boolean> {
  if (!(await isDaemonRunning())) return false;
  let client: Awaited<ReturnType<typeof connectToDaemon>>;
  try {
    client = await connectToDaemon();
  } catch {
    return false;
  }
  try {
    client.send({ cmd: 'backup-set-rate', ...update });
    const ack = await client.waitFor(
      (m) => (m.kind === 'ack' || m.kind === 'error') && m.cmd === 'backup-set-rate',
      2000,
    );
    return ack.kind === 'ack';
  } catch {
    return false;
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// Props + local types
// ---------------------------------------------------------------------------

export interface BackupSettingsProps {
  config: CliConfig;
  onBack: () => void;
}

type Step = 'menu' | 'edit-text' | 'edit-schedule';
type ScalarField = 'concurrency' | 'maxMbps' | 'cron';

interface SelectItem {
  label: string;
  value: string;
}

export function BackupSettings({ config, onBack }: BackupSettingsProps): React.ReactElement {
  const settings = new SettingsRepo(getDb());
  const root = settings.backupRoot();
  const nodeId = settings.backupNodeId();

  const [concurrency, setConcurrency] = useState<number>(() => settings.backupConcurrency());
  const [maxMbps, setMaxMbps] = useState<number>(() => settings.backupMaxMbps());
  const [serverConfig, setServerConfig] = useState<NodeBackupConfig | null>(null);
  const [serverError, setServerError] = useState<string>('');

  const [step, setStep] = useState<Step>('menu');
  const [editingField, setEditingField] = useState<ScalarField>('concurrency');
  const [inputVal, setInputVal] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');

  // Load the server-owned schedule once.
  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });
        const res = await api.getNodeBackupConfig(nodeId);
        if (!cancelled) setServerConfig(res.config);
      } catch (err) {
        if (!cancelled) {
          setServerError(
            err instanceof ApiError
              ? err.serverMessage
              : err instanceof Error
                ? err.message
                : String(err),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSchedule = useCallback(
    async (cron: string | null): Promise<void> => {
      if (!nodeId) {
        setErrorMsg('No backup root is bound — run `memoriahub backup init --dest <dir>` first.');
        return;
      }
      try {
        const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });
        const res = await api.putNodeBackupConfig(nodeId, { scheduleCron: cron });
        setServerConfig(res.config);
        setSuccessMsg(
          cron === null
            ? 'Schedule cleared — no more scheduled runs.'
            : `Schedule set: ${cron} (next: ${res.config?.nextRunAt ?? 'unknown'})`,
        );
        setErrorMsg('');
      } catch (err) {
        setErrorMsg(
          err instanceof ApiError
            ? err.serverMessage
            : `Schedule update failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [config, nodeId],
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

  // ---- schedule-preset keys ----
  useInput((_input, key) => {
    if (step !== 'edit-schedule') return;
    if (key.escape) setStep('menu');
  });

  const handleSelect = useCallback(
    (item: SelectItem): void => {
      setSuccessMsg('');
      setErrorMsg('');
      switch (item.value) {
        case 'concurrency':
          setEditingField('concurrency');
          setInputVal(String(concurrency));
          setStep('edit-text');
          break;
        case 'maxMbps':
          setEditingField('maxMbps');
          setInputVal(String(maxMbps));
          setStep('edit-text');
          break;
        case 'schedule':
          setStep('edit-schedule');
          break;
        case 'cron':
          setEditingField('cron');
          setInputVal(serverConfig?.scheduleCron ?? '');
          setStep('edit-text');
          break;
        case 'root':
          setErrorMsg(
            'The backup root is read-only here — re-bind it with `memoriahub backup init --dest <dir>`.',
          );
          break;
      }
    },
    [concurrency, maxMbps, serverConfig],
  );

  const handleScheduleSelect = useCallback(
    (item: SelectItem): void => {
      const preset = SCHEDULE_PRESETS.find((p) => p.label === item.label);
      setStep('menu');
      if (!preset) return;
      void saveSchedule(preset.cron);
    },
    [saveSchedule],
  );

  const handleSubmit = useCallback(
    (value: string): void => {
      const trimmed = value.trim();

      if (editingField === 'cron') {
        setStep('menu');
        if (trimmed.length === 0) {
          setErrorMsg('Enter a 5-field cron expression, or pick "Disable" from the presets.');
          return;
        }
        void saveSchedule(trimmed);
        return;
      }

      const n = Number(trimmed);
      if (editingField === 'concurrency') {
        if (!Number.isInteger(n) || n < 1 || n > 32) {
          setErrorMsg(`Invalid concurrency: ${trimmed} (expected an integer 1-32)`);
          return;
        }
        settings.setBackupConcurrency(n);
        setConcurrency(n);
        setStep('menu');
        void pushRateLive({ concurrency: n }).then((live) => {
          setSuccessMsg(
            live
              ? `Concurrency ${n} — applied live to the running daemon.`
              : `Concurrency ${n} — applies from the next run.`,
          );
        });
        return;
      }

      // maxMbps
      if (!Number.isFinite(n) || n < 0) {
        setErrorMsg(`Invalid bandwidth cap: ${trimmed} (expected a non-negative number; 0 = unlimited)`);
        return;
      }
      settings.setBackupMaxMbps(n);
      setMaxMbps(n);
      setStep('menu');
      void pushRateLive({ maxMbps: n }).then((live) => {
        setSuccessMsg(
          live
            ? `Bandwidth cap ${n > 0 ? `${n} Mbps` : 'unlimited'} — applied live to the running daemon.`
            : `Bandwidth cap ${n > 0 ? `${n} Mbps` : 'unlimited'} — applies from the next run.`,
        );
      });
    },
    [editingField, saveSchedule, settings],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const fieldLabel =
    editingField === 'concurrency'
      ? 'Concurrent download workers (1-32)'
      : editingField === 'maxMbps'
        ? 'Bandwidth cap in Mbps (0 = unlimited)'
        : 'Cron expression (5 fields, e.g. "0 3 * * *")';

  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">MemoriaHub — Backup Settings</Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          Root      : <Text dimColor>{root ?? '(not configured — run `backup init`)'}</Text>
        </Text>
        <Text>
          Schedule  :{' '}
          <Text dimColor>
            {serverError
              ? `(server unreachable: ${serverError})`
              : (serverConfig?.scheduleCron ?? '(none)')}
            {serverConfig?.timezone ? ` (${serverConfig.timezone})` : ''}
          </Text>
        </Text>
        <Text>
          Next run  : <Text dimColor>{serverConfig?.nextRunAt ?? '(not scheduled)'}</Text>
        </Text>
        <Text>
          Rate      :{' '}
          <Text dimColor>{`concurrency ${concurrency}, ${maxMbps > 0 ? `${maxMbps} Mbps` : 'unlimited'}`}</Text>
        </Text>
      </Box>

      {step === 'menu' ? (
        <Box marginTop={1} flexDirection="column">
          <SelectInput
            items={[
              { label: 'Backup root (read-only)', value: 'root' },
              { label: 'Schedule — pick a preset', value: 'schedule' },
              { label: 'Schedule — enter a custom cron', value: 'cron' },
              { label: `Concurrency (${concurrency})`, value: 'concurrency' },
              {
                label: `Bandwidth cap (${maxMbps > 0 ? `${maxMbps} Mbps` : 'unlimited'})`,
                value: 'maxMbps',
              },
            ]}
            onSelect={handleSelect}
          />
          <Box marginTop={1}>
            <Text dimColor>[↑/↓] move · [Enter] edit · [Esc/q] back</Text>
          </Box>
        </Box>
      ) : null}

      {step === 'edit-schedule' ? (
        <Box marginTop={1} flexDirection="column">
          <Text>Pick a schedule (the server computes the next fire time):</Text>
          <SelectInput
            items={SCHEDULE_PRESETS.map((p) => ({
              label: p.cron === null ? p.label : `${p.label}  (${p.cron})`,
              value: p.cron ?? 'disable',
            }))}
            onSelect={(item) =>
              handleScheduleSelect({
                label:
                  SCHEDULE_PRESETS.find((p) => (p.cron ?? 'disable') === item.value)?.label ?? '',
                value: String(item.value),
              })
            }
          />
          <Box marginTop={1}>
            <Text dimColor>[Esc] cancel</Text>
          </Box>
        </Box>
      ) : null}

      {step === 'edit-text' ? (
        <Box marginTop={1} flexDirection="column">
          <Text>{fieldLabel}:</Text>
          <TextInput value={inputVal} onChange={setInputVal} onSubmit={handleSubmit} />
        </Box>
      ) : null}

      {errorMsg ? (
        <Box marginTop={1}>
          <Text color="red">{errorMsg}</Text>
        </Box>
      ) : null}
      {successMsg ? (
        <Box marginTop={1}>
          <Text color="green">{successMsg}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
