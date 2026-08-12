/**
 * tui/NodeStop.tsx — Ink screen that stops a running worker-node daemon.
 *
 * The counterpart to NodeStart.tsx (issue #413): the TUI could start a
 * background daemon but had no way to stop one, forcing an operator out to a
 * shell for `memoriahub node stop`.
 *
 * Mirrors `stopCmd()` in commands/node.ts step for step, including its
 * three-tier escalation and the reasons for that order:
 *   1. IPC over ~/.memoriahub/node.sock — the graceful path: the daemon drains
 *      in-flight jobs and deregisters itself server-side before exiting.
 *   2. SIGTERM via the pidfile — the daemon's own signal handler does the same
 *      drain+deregister; used when the socket is gone but the process isn't.
 *   3. Server-side deregister — no local process to signal, so at least stop
 *      new jobs being dispatched to this node. Needs a config; when there is
 *      none this screen reports "nothing to stop" instead of erroring, since a
 *      machine that was never registered has nothing to clean up.
 *
 * Every step reports into the same `lines` log the screen renders, so a
 * partial escalation (IPC failed → SIGTERM worked) is visible rather than
 * collapsed into one final verdict.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';

import type { CliConfig } from '../config.js';
import { ApiClient } from '../api.js';
import { nodePidPath } from '../paths.js';
import { readPidFile, isPidAlive } from '../node/daemon.js';
import { connectToDaemon, isDaemonRunning } from '../node/ipc-client.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props + local types
// ---------------------------------------------------------------------------

export interface NodeStopProps {
  config: CliConfig | null;
  /** Called after a successful stop, so the caller can refresh node state. */
  onStopped?: () => void;
  onBack: () => void;
}

type Step = 'confirm' | 'stopping' | 'done';
export type StopTone = 'info' | 'success' | 'warn' | 'error' | 'dim';

export interface StopLine {
  text: string;
  tone: StopTone;
}

export interface StopOutcome {
  lines: StopLine[];
  ok: boolean;
}

function toneColor(tone: StopTone): string | undefined {
  switch (tone) {
    case 'success':
      return 'green';
    case 'warn':
      return 'yellow';
    case 'error':
      return 'red';
    default:
      return undefined;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Stop sequence — headless, so it is unit-testable without Ink
// ---------------------------------------------------------------------------

/** IPC → SIGTERM → server-side deregister, mirroring `node stop`. */
export async function runStopSequence(config: CliConfig | null): Promise<StopOutcome> {
  const lines: StopLine[] = [];

  // 1. Graceful stop over IPC.
  if (await isDaemonRunning()) {
    lines.push({ text: 'Daemon socket found — requesting a graceful stop…', tone: 'dim' });
    try {
      const client = await connectToDaemon();
      const closed = new Promise<void>((resolve) => client.onClose(resolve));
      client.send({ cmd: 'stop' });
      await client.waitFor((m) => m.kind === 'ack' && m['cmd'] === 'stop', 15_000);
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 15_000).unref?.();
        }),
      ]);
      client.close();
      lines.push({
        text: 'Worker node stopped via IPC (drained and deregistered).',
        tone: 'success',
      });
      return { lines, ok: true };
    } catch (err) {
      lines.push({ text: `IPC stop failed: ${errMsg(err)} — trying SIGTERM…`, tone: 'warn' });
    }
  }

  // 2. SIGTERM via the pidfile.
  const pidInfo = readPidFile(nodePidPath());
  if (pidInfo && isPidAlive(pidInfo.pid)) {
    try {
      process.kill(pidInfo.pid, 'SIGTERM');
      lines.push({
        text: `Sent SIGTERM to worker node (pid ${pidInfo.pid}) — it will drain and deregister.`,
        tone: 'success',
      });
      return { lines, ok: true };
    } catch (err) {
      lines.push({ text: `Could not signal pid ${pidInfo.pid}: ${errMsg(err)}`, tone: 'warn' });
    }
  }

  // 3. Server-side deregister.
  lines.push({
    text: 'No local worker node process found — falling back to server-side deregister.',
    tone: 'info',
  });
  if (!config) {
    lines.push({ text: 'Not logged in and no local daemon — nothing to stop.', tone: 'warn' });
    return { lines, ok: false };
  }
  if (!config.nodeId) {
    lines.push({ text: 'This machine is not registered as a worker node.', tone: 'warn' });
    return { lines, ok: false };
  }
  try {
    const api = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });
    await api.deregisterNode(config.nodeId);
    lines.push({
      text: 'Node deregistered server-side (no new jobs will be dispatched).',
      tone: 'success',
    });
    return { lines, ok: true };
  } catch (err) {
    lines.push({ text: `Could not deregister node server-side: ${errMsg(err)}`, tone: 'error' });
    return { lines, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeStop({ config, onStopped, onBack }: NodeStopProps): React.ReactElement {
  const [step, setStep] = useState<Step>('confirm');
  const [outcome, setOutcome] = useState<StopOutcome | null>(null);

  const stop = useCallback((): void => {
    setStep('stopping');
    void runStopSequence(config)
      .then((res) => {
        setOutcome(res);
        setStep('done');
        if (res.ok) onStopped?.();
      })
      .catch((err: unknown) => {
        setOutcome({ ok: false, lines: [{ text: `Unexpected error: ${errMsg(err)}`, tone: 'error' }] });
        setStep('done');
      });
  }, [config, onStopped]);

  useInput((input, key) => {
    if (step === 'confirm') {
      if (key.return || input === 's') stop();
      else if (key.escape || input === 'q' || input === 'b') onBack();
      return;
    }
    if (step === 'stopping') return; // ignore input while draining
    if (key.escape || input === 'q' || input === 'b' || key.return) onBack();
  });

  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Worker Node — Stop</Text>

      {step === 'confirm' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            Stops the background worker daemon: in-flight jobs are drained and the node
            deregisters itself, so no work is lost.
          </Text>
          <Box marginTop={1}>
            <Text dimColor>[Enter/s] stop worker   [Esc/b] back</Text>
          </Box>
        </Box>
      )}

      {step === 'stopping' && (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text dimColor>Stopping worker node (draining in-flight jobs)…</Text>
        </Box>
      )}

      {step === 'done' && outcome && (
        <Box flexDirection="column" marginTop={1}>
          {outcome.lines.map((l, i) => (
            <Text key={i} color={toneColor(l.tone)} dimColor={l.tone === 'dim'}>
              {l.tone === 'success' ? '✔ ' : l.tone === 'error' ? '✖ ' : l.tone === 'warn' ? '⚠ ' : ''}
              {l.text}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text dimColor>[Enter/Esc] back</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
