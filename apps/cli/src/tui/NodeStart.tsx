/**
 * tui/NodeStart.tsx — Ink screen that launches a real background worker-node
 * daemon (`memoriahub node start --daemon`) from the TUI.
 *
 * NodeDashboard.tsx can run the engine EMBEDDED (tied to that screen's
 * lifetime) or ATTACH to a daemon that is already running, but until now
 * nothing in the TUI could actually START a persistent background daemon —
 * only the shell command could. This screen wraps node/daemon-launch.ts's
 * argv-independent spawn helper so an operator can start one from here, then
 * hand off to the dashboard (which auto-attaches over IPC).
 *
 * Steps:
 *   'checking'         — on mount, only reached when the machine IS
 *                         registered: checkNodeAlreadyRunning() (spinner)
 *   'not-registered'   — config.nodeId is unset; short-circuits with
 *                         guidance to register first. Does not embed the
 *                         registration wizard.
 *   'already-running'  — a daemon is already up (pidfile or IPC); offers to
 *                         jump straight to the dashboard instead of starting
 *                         a second one
 *   'form'             — concurrency + eligible-types confirmation, prefilled
 *                         from config.node; concurrency mirrors NodeConfig.tsx's
 *                         TextInput-with-validation field (typed digits) plus
 *                         an up/down-arrow stepper in the spirit of
 *                         NodeLogs.tsx's +/- tail-size adjuster (arrows are
 *                         used instead of literal +/- because ink-text-input
 *                         only no-ops on arrow keys, not on printable chars —
 *                         see the in-line comment on the form-step handler);
 *                         eligible types reuse NodeConfig.tsx's checkbox-list
 *                         (↑/↓ move, space toggle)
 *   'starting'         — spawnNodeStartDaemon() + waitForDaemonReady() (spinner)
 *   'success'          — daemon confirmed ready; mirrors NodeRegister.tsx's
 *                         'success' step (Enter/Esc/q proceeds)
 *   'timeout'          — spawned but readiness wasn't confirmed in time;
 *                         offers to open the dashboard anyway or go back
 *   'error'            — spawnNodeStartDaemon() threw synchronously
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';

import type { CliConfig } from '../config.js';
import { NODE_JOB_TYPES } from '../node/capabilities.js';
import {
  spawnNodeStartDaemon,
  checkNodeAlreadyRunning,
  waitForDaemonReady,
  type AlreadyRunningCheck,
  type SpawnedDaemonResult,
} from '../node/daemon-launch.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Defaults (mirror commands/node.ts / NodeConfig.tsx)
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 1;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;

// ---------------------------------------------------------------------------
// Props + local types
// ---------------------------------------------------------------------------

export interface NodeStartProps {
  config: CliConfig;
  /** Called once the daemon is confirmed running — caller should navigate to the dashboard (which auto-attaches). */
  onStarted: () => void;
  onBack: () => void;
}

type Step =
  | 'checking'
  | 'not-registered'
  | 'already-running'
  | 'form'
  | 'starting'
  | 'success'
  | 'timeout'
  | 'error';

type FormFocus = 'concurrency' | 'types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initialConcurrency(config: CliConfig): number {
  return Math.max(MIN_CONCURRENCY, config.node?.concurrency ?? DEFAULT_CONCURRENCY);
}

function initialTypes(config: CliConfig): string[] {
  return config.node?.eligibleTypes && config.node.eligibleTypes.length > 0
    ? config.node.eligibleTypes.filter((t) => (NODE_JOB_TYPES as readonly string[]).includes(t))
    : [...NODE_JOB_TYPES];
}

// ---------------------------------------------------------------------------
// NodeStart component
// ---------------------------------------------------------------------------

export function NodeStart({ config, onStarted, onBack }: NodeStartProps): React.ReactElement {
  const [step, setStep] = useState<Step>(config.nodeId ? 'checking' : 'not-registered');
  const [already, setAlready] = useState<AlreadyRunningCheck | null>(null);

  const [concurrencyStr, setConcurrencyStr] = useState<string>(String(initialConcurrency(config)));
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set(initialTypes(config)));
  const [focus, setFocus] = useState<FormFocus>('concurrency');
  const [typeCursor, setTypeCursor] = useState<number>(0);
  const [fieldError, setFieldError] = useState<string>('');

  const [spawnResult, setSpawnResult] = useState<SpawnedDaemonResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---- mount-time gate: registration + already-running check ----
  useEffect(() => {
    if (step !== 'checking') return;
    void checkNodeAlreadyRunning().then((res) => {
      if (!mountedRef.current) return;
      if (res.running) {
        setAlready(res);
        setStep('already-running');
      } else {
        setStep('form');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- spawn the daemon + wait for readiness ----
  const startDaemon = useCallback((concurrency: number, types: string[]): void => {
    setStep('starting');
    try {
      const result = spawnNodeStartDaemon({ concurrency, types });
      setSpawnResult(result);
      void waitForDaemonReady().then((ready) => {
        if (!mountedRef.current) return;
        setStep(ready ? 'success' : 'timeout');
      });
    } catch (err) {
      setErrorMsg(`Failed to start worker daemon: ${err instanceof Error ? err.message : String(err)}`);
      setStep('error');
    }
  }, []);

  // ---- concurrency validation + adjustment ----
  const validateConcurrency = useCallback((): number | null => {
    const trimmed = concurrencyStr.trim();
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n < MIN_CONCURRENCY || n > MAX_CONCURRENCY || String(n) !== trimmed) {
      setFieldError(
        `Concurrency must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY} (got "${trimmed}").`,
      );
      return null;
    }
    return n;
  }, [concurrencyStr]);

  const adjustConcurrency = useCallback((delta: number): void => {
    setFieldError('');
    setConcurrencyStr((prev) => {
      const n = parseInt(prev, 10);
      const base = isNaN(n) ? DEFAULT_CONCURRENCY : n;
      return String(Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, base + delta)));
    });
  }, []);

  const advanceFromConcurrency = useCallback((): void => {
    if (validateConcurrency() === null) return;
    setFieldError('');
    setFocus('types');
  }, [validateConcurrency]);

  const submitForm = useCallback((): void => {
    const n = validateConcurrency();
    if (n === null) {
      setFocus('concurrency');
      return;
    }
    if (selectedTypes.size === 0) {
      setFieldError('Select at least one job type (space to toggle).');
      return;
    }
    setFieldError('');
    const ordered = NODE_JOB_TYPES.filter((t) => selectedTypes.has(t));
    startDaemon(n, [...ordered]);
  }, [validateConcurrency, selectedTypes, startDaemon]);

  // ---- not-registered step ----
  useInput((input, key) => {
    if (step !== 'not-registered') return;
    if (key.return || input === 'b' || key.escape || input === 'q') onBack();
  });

  // ---- already-running step ----
  useInput((input, key) => {
    if (step !== 'already-running') return;
    if (key.return) {
      onStarted();
      return;
    }
    if (input === 'b' || key.escape || input === 'q') onBack();
  });

  // ---- form step ----
  useInput((input, key) => {
    if (step !== 'form') return;
    if (key.escape || input === 'b') {
      onBack();
      return;
    }
    if (key.tab) {
      setFieldError('');
      setFocus((f) => (f === 'concurrency' ? 'types' : 'concurrency'));
      return;
    }
    if (focus === 'concurrency') {
      // ink-text-input's own useInput no-ops on upArrow/downArrow/tab (it only
      // consumes left/right/backspace/delete/printable chars/return), so it's
      // safe to use the arrow keys here for a NodeLogs.tsx-style +/- stepper
      // without fighting the focused TextInput over the keystroke. Printable
      // '+'/'-' are deliberately NOT bound here — those chars ARE consumed by
      // TextInput (inserted into the value), which would race this handler.
      if (key.upArrow) {
        adjustConcurrency(1);
        return;
      }
      if (key.downArrow) {
        adjustConcurrency(-1);
        return;
      }
      return;
    }
    // focus === 'types'
    if (key.upArrow) {
      setTypeCursor((c) => (c - 1 + NODE_JOB_TYPES.length) % NODE_JOB_TYPES.length);
      return;
    }
    if (key.downArrow) {
      setTypeCursor((c) => (c + 1) % NODE_JOB_TYPES.length);
      return;
    }
    if (input === ' ') {
      setFieldError('');
      setSelectedTypes((prev) => {
        const next = new Set(prev);
        const t = NODE_JOB_TYPES[typeCursor];
        if (next.has(t)) next.delete(t);
        else next.add(t);
        return next;
      });
      return;
    }
    if (key.return) {
      submitForm();
    }
  });

  // ---- success step (mirrors NodeRegister's success step) ----
  useInput((input, key) => {
    if (step !== 'success') return;
    if (key.return || input === 'q' || key.escape) onStarted();
  });

  // ---- timeout step ----
  useInput((input, key) => {
    if (step !== 'timeout') return;
    if (key.return) {
      onStarted();
      return;
    }
    if (input === 'b' || key.escape || input === 'q') onBack();
  });

  // ---- error step ----
  useInput((input, key) => {
    if (step !== 'error') return;
    if (input === 'b' || key.escape || input === 'q' || key.return) onBack();
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (step === 'checking') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Start</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /> Checking for an existing daemon…</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'not-registered') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="yellow" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="yellow">Worker Node — Start</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">⚠ This machine is not registered as a worker node.</Text>
          <Text dimColor>Run Register node first, then come back here to start the daemon.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Enter/b] back</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'already-running') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="yellow" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="yellow">Worker Node — Start</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">
            ⚠ A worker-node daemon is already running (pid {already?.pid ?? '?'}, via {already?.via ?? '?'}).
          </Text>
          <Text dimColor>Open the dashboard to attach to it instead of starting a second one.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Enter] go to dashboard   [b] back</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'starting') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Start</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /> Starting worker daemon…</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'success') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Start</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="green">✔ Worker daemon started (pid {spawnResult?.pid ?? '?'}).</Text>
          <Text dimColor>Log: {spawnResult?.logPath ?? '?'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Enter/Esc/q] open dashboard</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'timeout') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="yellow" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="yellow">Worker Node — Start</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">
            ⚠ Daemon process started (pid {spawnResult?.pid ?? '?'}) but didn't confirm readiness in time.
          </Text>
          <Text dimColor>Output log: {spawnResult?.outPath ?? '?'}</Text>
          <Text dimColor>Node log: {spawnResult?.logPath ?? '?'}</Text>
          <Text dimColor>Investigate the logs above if this persists.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Enter] open dashboard anyway   [b] back</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'error') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Start</Text>
        <Box marginTop={1}>
          <Text color="red">✖ {errorMsg}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[b] back</Text>
        </Box>
      </Box>
    );
  }

  // 'form'
  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Worker Node — Start</Text>
      <Text dimColor>Confirm concurrency and eligible job types, then start the background daemon.</Text>

      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text color={focus === 'concurrency' ? 'cyan' : undefined}>{focus === 'concurrency' ? '❯' : ' '}</Text>
        <Text color={focus === 'concurrency' ? 'cyan' : undefined}>{'Concurrency'.padEnd(14)}</Text>
        <TextInput
          value={concurrencyStr}
          onChange={setConcurrencyStr}
          onSubmit={advanceFromConcurrency}
          focus={focus === 'concurrency'}
        />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={focus === 'types' ? 'cyan' : undefined}>{focus === 'types' ? '❯' : ' '}</Text>
          <Text color={focus === 'types' ? 'cyan' : undefined}>
            {'Eligible types'.padEnd(14)} ({selectedTypes.size}/{NODE_JOB_TYPES.length})
          </Text>
        </Box>
        {NODE_JOB_TYPES.map((t, i) => {
          const checked = selectedTypes.has(t);
          const isCursor = focus === 'types' && i === typeCursor;
          return (
            <Box key={t} flexDirection="row" gap={1} marginLeft={2}>
              <Text color={isCursor ? 'cyan' : undefined}>{isCursor ? '❯' : ' '}</Text>
              <Text color={checked ? 'green' : undefined}>{checked ? '[x]' : '[ ]'}</Text>
              <Text color={isCursor ? 'cyan' : undefined}>{t}</Text>
            </Box>
          );
        })}
      </Box>

      {fieldError ? (
        <Box marginTop={1}>
          <Text color="red">✖ {fieldError}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          [Tab] switch field  [↑/↓] adjust concurrency / move types  [space] toggle type  [Enter] confirm & start  [Esc/b] back
        </Text>
      </Box>
    </Box>
  );
}
