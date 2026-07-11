/**
 * tui/NodeList.tsx — Ink screen listing registered worker nodes.
 *
 * Reuses the exact same call + response-shape handling as `listCmd()` in
 * commands/node.ts: `GET /api/nodes` (owner-scoped — lists nodes registered
 * by the caller), tolerating both a bare array response and an
 * `{ items: [] }` envelope, and the same 403/404 tolerance that falls back to
 * showing the machine's local node config when the endpoint isn't available
 * with the current token (older server, or a token without permission).
 *
 * Rendered as an Ink Box/Text grid (padEnd-aligned columns) rather than
 * cli-table3 — matching the convention already established by JobsDashboard
 * and NodeDoctor's capability table; cli-table3 (used by the plain-CLI
 * `node list`/`node doctor` commands) is a stdout-only renderer and isn't
 * used anywhere inside the Ink TUI screens.
 *
 * Keys: [r] refresh, [Esc/q] back.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';

import { ApiClient, ApiError } from '../api.js';
import type { CliConfig } from '../config.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeListProps {
  config: CliConfig;
  onBack: () => void;
}

/** Loosely typed — the server owns the full node schema; only these fields
 *  are relied on for display, mirroring listCmd()'s own loose typing. */
interface NodeRow {
  id: string;
  name: string;
  status: string;
  platform: string;
  concurrency?: number;
  eligibleTypes?: string[];
  lastHeartbeatAt?: string | null;
}

type Step = 'loading' | 'ready' | 'empty' | 'fallback' | 'error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/** "3s ago" / "4m ago" / "2h ago" / "3d ago" relative time from an ISO timestamp. */
function relTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const secs = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Normalize the two response shapes listCmd() tolerates: a bare array, or
 *  an `{ items: [] }` envelope. */
function normalizeNodes(res: unknown): NodeRow[] {
  const raw = Array.isArray(res)
    ? (res as Array<Record<string, unknown>>)
    : ((res as { items?: Array<Record<string, unknown>> })?.items ?? []);
  return raw.map((n) => ({
    id: String(n['id'] ?? n['nodeId'] ?? ''),
    name: String(n['name'] ?? ''),
    status: String(n['status'] ?? ''),
    platform: String(n['platform'] ?? ''),
    concurrency: typeof n['concurrency'] === 'number' ? (n['concurrency'] as number) : undefined,
    eligibleTypes: Array.isArray(n['eligibleTypes']) ? (n['eligibleTypes'] as string[]) : undefined,
    lastHeartbeatAt:
      typeof n['lastHeartbeatAt'] === 'string' ? (n['lastHeartbeatAt'] as string) : null,
  }));
}

function statusColor(status: string): string | undefined {
  switch (status) {
    case 'online':
      return 'green';
    case 'draining':
      return 'yellow';
    case 'offline':
    case 'disabled':
      return 'red';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeList({ config, onBack }: NodeListProps): React.ReactElement {
  const [step, setStep] = useState<Step>('loading');
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [message, setMessage] = useState<string>('');
  const [, setTick] = useState<number>(0);

  const load = useCallback((): void => {
    setStep('loading');
    const api = new ApiClient(config);
    void (async () => {
      try {
        const res = await api.get<unknown>('/api/nodes');
        const rows = normalizeNodes(res);
        if (rows.length === 0) {
          setNodes([]);
          setStep('empty');
        } else {
          setNodes(rows);
          setStep('ready');
        }
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setMessage(
            'Listing worker nodes is not available with this token (or the endpoint is not exposed). ' +
              'Showing local config only.',
          );
          setStep('fallback');
          return;
        }
        setMessage(`Failed to list nodes: ${err instanceof Error ? err.message : String(err)}`);
        setStep('error');
      }
    })();
  }, [config]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1s ticker so "Xs ago" heartbeat labels stay fresh.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useInput((input, key) => {
    if (input === 'r') {
      load();
      return;
    }
    if (key.escape || input === 'q') onBack();
  });

  const now = Date.now();

  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Worker Nodes</Text>

      {step === 'loading' && (
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /> Loading registered nodes…</Text>
        </Box>
      )}

      {step === 'empty' && (
        <Box marginTop={1}>
          <Text dimColor>No worker nodes registered.</Text>
        </Box>
      )}

      {step === 'fallback' && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">⚠ {message}</Text>
          <Text dimColor>
            This node: {config.nodeId ?? '(not registered)'} — {config.node?.name ?? ''}
          </Text>
        </Box>
      )}

      {step === 'error' && (
        <Box marginTop={1}>
          <Text color="red">✖ {message}</Text>
        </Box>
      )}

      {step === 'ready' && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Text bold dimColor>{'Name'.padEnd(20)}</Text>
            <Text bold dimColor>{'ID'.padEnd(10)}</Text>
            <Text bold dimColor>{'Status'.padEnd(10)}</Text>
            <Text bold dimColor>{'Conc.'.padEnd(6)}</Text>
            <Text bold dimColor>{'Heartbeat'.padEnd(11)}</Text>
            <Text bold dimColor>Types</Text>
          </Box>
          {nodes.map((n) => (
            <Box key={n.id} flexDirection="row">
              <Text>{truncate(n.name || '(unnamed)', 19).padEnd(20)}</Text>
              <Text dimColor>{shortId(n.id).padEnd(10)}</Text>
              <Text color={statusColor(n.status)} dimColor={!statusColor(n.status)}>
                {(n.status || '—').padEnd(10)}
              </Text>
              <Text dimColor>{String(n.concurrency ?? '—').padEnd(6)}</Text>
              <Text dimColor>{relTime(n.lastHeartbeatAt, now).padEnd(11)}</Text>
              <Text dimColor>{truncate((n.eligibleTypes ?? []).join(', ') || '(none)', 40)}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>[r] refresh   [Esc/q] back</Text>
      </Box>
    </Box>
  );
}
