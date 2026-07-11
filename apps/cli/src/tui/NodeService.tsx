/**
 * tui/NodeService.tsx — Ink screen for the systemd user unit that keeps the
 * worker node always on (install / uninstall / status).
 *
 * Mirrors `serviceCmd()` in commands/node.ts exactly: same unit-file template,
 * same `~/.config/systemd/user/memoriahub-node.service` path, same
 * WSL/Windows guidance, same "status exit 3 is not a failure" handling.
 *
 * IMPORTANT — Ink/stdio adaptation (deliberate, not a deviation to avoid):
 * `serviceCmd()`'s `systemctlUser()` helper runs
 * `spawnSync('systemctl', [...], { stdio: 'inherit' })`, handing the child
 * process direct control of the terminal. That is fine for a plain CLI
 * command where nothing else owns the terminal, but it WOULD CONFLICT here —
 * Ink owns stdout/stdin/raw-mode for its own render loop, and `inherit` would
 * race with (and likely corrupt) that render loop. This screen instead runs
 * every `systemctl --user ...` call with `{ encoding: 'utf8' }` (captures
 * stdout/stderr instead of inheriting the terminal — see `runSystemctlUser`
 * below) and renders the captured output as Ink `<Text>` rows in the screen's
 * own layout.
 *
 * The small unit-file template string is intentionally DUPLICATED here rather
 * than extracted into a shared module — this screen owns exactly two new
 * files by design (see the task boundary), and the template is a handful of
 * static lines that rarely change. If `serviceCmd()`'s template in
 * commands/node.ts ever changes, `unitFileContent()` below must be updated to
 * match.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NodeServiceProps {
  /** Pop back to the previous screen/menu. */
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Constants (mirror commands/node.ts's serviceCmd — see file header)
// ---------------------------------------------------------------------------

export const SERVICE_UNIT = 'memoriahub-node.service';

export function systemdUserDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

/** The exact unit-file template `node service install` writes. */
export function unitFileContent(): string {
  const entry = path.resolve(process.argv[1] ?? '');
  return [
    '[Unit]',
    'Description=MemoriaHub worker node',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${process.execPath} ${entry} node start`,
    'Restart=on-failure',
    'RestartSec=5',
    'Environment=NODE_ENV=production',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// systemctl helpers — output-CAPTURING, not stdio:'inherit' (see file header)
// ---------------------------------------------------------------------------

export interface SystemctlResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** True when a per-user systemd instance is reachable. */
export function hasUserSystemd(): boolean {
  try {
    const res = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Run `systemctl --user <args>`, capturing output instead of inheriting the terminal. */
export function runSystemctlUser(args: string[]): SystemctlResult {
  try {
    const res = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } catch (err) {
    return { status: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

function splitNonEmpty(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Action reports — pure(ish) orchestration, unit-testable with a mocked spawnSync
// ---------------------------------------------------------------------------

export type ReportTone = 'info' | 'success' | 'error' | 'dim';

export interface ReportLine {
  text: string;
  tone: ReportTone;
}

export interface ServiceActionReport {
  lines: ReportLine[];
  ok: boolean;
}

function noUserSystemdLines(): ReportLine[] {
  return [
    { text: 'No per-user systemd instance is available.', tone: 'error' },
    {
      text:
        'On WSL, enable systemd by adding "[boot]\\nsystemd=true" to /etc/wsl.conf and restarting ' +
        'the distro (`wsl --shutdown`), or skip systemd entirely with `memoriahub node start --daemon`.',
      tone: 'info',
    },
  ];
}

function pushSystemctlOutput(lines: ReportLine[], label: string, res: SystemctlResult): void {
  const ok = res.status === 0;
  lines.push({ text: `$ systemctl --user ${label}`, tone: 'dim' });
  for (const l of splitNonEmpty(res.stdout)) lines.push({ text: l, tone: 'info' });
  for (const l of splitNonEmpty(res.stderr)) lines.push({ text: l, tone: ok ? 'dim' : 'error' });
  lines.push({
    text: ok ? '✔ succeeded (exit 0)' : `✖ failed (exit ${res.status ?? 'signal'})`,
    tone: ok ? 'success' : 'error',
  });
}

/** Write the unit file, daemon-reload, and enable --now — same sequence as `node service install`. */
export function runInstall(): ServiceActionReport {
  const lines: ReportLine[] = [];

  if (os.platform() === 'win32') {
    lines.push({
      text: 'systemd services are not available on Windows — use `node start --daemon`.',
      tone: 'error',
    });
    return { lines, ok: false };
  }
  if (!hasUserSystemd()) {
    return { lines: noUserSystemdLines(), ok: false };
  }

  const dir = systemdUserDir();
  const unitPath = path.join(dir, SERVICE_UNIT);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(unitPath, unitFileContent());
    lines.push({ text: `Wrote ${unitPath}`, tone: 'success' });
  } catch (err) {
    lines.push({
      text: `Failed to write unit file: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'error',
    });
    return { lines, ok: false };
  }

  const reload = runSystemctlUser(['daemon-reload']);
  pushSystemctlOutput(lines, 'daemon-reload', reload);
  if (reload.status !== 0) return { lines, ok: false };

  const enable = runSystemctlUser(['enable', '--now', SERVICE_UNIT]);
  pushSystemctlOutput(lines, `enable --now ${SERVICE_UNIT}`, enable);
  if (enable.status !== 0) return { lines, ok: false };

  lines.push({ text: 'Service enabled and started.', tone: 'success' });
  lines.push({
    text:
      'Follow logs with `memoriahub node logs --follow`, the Node Logs TUI screen, or ' +
      `\`journalctl --user -u ${SERVICE_UNIT} -f\`.`,
    tone: 'dim',
  });
  lines.push({
    text: 'Tip: `loginctl enable-linger $USER` keeps the service running after you log out.',
    tone: 'dim',
  });
  return { lines, ok: true };
}

/** Disable + remove the unit — same sequence as `node service uninstall`. */
export function runUninstall(): ServiceActionReport {
  if (!hasUserSystemd()) {
    return { lines: noUserSystemdLines(), ok: false };
  }
  const lines: ReportLine[] = [];
  const unitPath = path.join(systemdUserDir(), SERVICE_UNIT);

  // Best-effort, mirrors the CLI: the unit may already be gone.
  const disable = runSystemctlUser(['disable', '--now', SERVICE_UNIT]);
  pushSystemctlOutput(lines, `disable --now ${SERVICE_UNIT}`, disable);

  try {
    fs.unlinkSync(unitPath);
    lines.push({ text: `Removed ${unitPath}`, tone: 'success' });
  } catch {
    lines.push({ text: `Unit file not present (${unitPath}).`, tone: 'info' });
  }

  const reload = runSystemctlUser(['daemon-reload']);
  pushSystemctlOutput(lines, 'daemon-reload', reload);
  if (reload.status !== 0) return { lines, ok: false };

  lines.push({ text: 'Service uninstalled.', tone: 'success' });
  return { lines, ok: true };
}

/** `systemctl --user status memoriahub-node.service --no-pager` — same as `node service status`. */
export function runStatus(): ServiceActionReport {
  if (!hasUserSystemd()) {
    return { lines: noUserSystemdLines(), ok: false };
  }
  const lines: ReportLine[] = [];
  // Exit code 3 = unit inactive — still useful output, never treated as a hard failure.
  const res = runSystemctlUser(['status', SERVICE_UNIT, '--no-pager']);
  lines.push({ text: `$ systemctl --user status ${SERVICE_UNIT} --no-pager`, tone: 'dim' });
  for (const l of splitNonEmpty(res.stdout)) lines.push({ text: l, tone: 'info' });
  for (const l of splitNonEmpty(res.stderr)) lines.push({ text: l, tone: 'error' });
  lines.push({
    text: `(exit ${res.status ?? 'signal'} — nonzero is normal for an inactive/not-installed unit)`,
    tone: 'dim',
  });
  return { lines, ok: true };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Screen = 'menu' | 'result';
type ActionKind = 'install' | 'uninstall' | 'status';

function toneColor(tone: ReportTone): string | undefined {
  switch (tone) {
    case 'success':
      return 'green';
    case 'error':
      return 'red';
    default:
      return undefined;
  }
}

function actionLabel(a: ActionKind): string {
  switch (a) {
    case 'install':
      return 'Install';
    case 'uninstall':
      return 'Uninstall';
    case 'status':
      return 'Status';
  }
}

export function NodeService({ onBack }: NodeServiceProps): React.ReactElement {
  const [screen, setScreen] = useState<Screen>('menu');
  const [action, setAction] = useState<ActionKind | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  const [report, setReport] = useState<ServiceActionReport | null>(null);

  const runAction = useCallback((kind: ActionKind): void => {
    setAction(kind);
    setReport(null);
    setRunning(true);
    setScreen('result');
    // spawnSync is synchronous; defer one tick so the "running…" spinner has
    // a chance to paint before the (normally sub-second) systemctl calls
    // resolve and the report replaces it.
    setTimeout(() => {
      let result: ServiceActionReport;
      try {
        result = kind === 'install' ? runInstall() : kind === 'uninstall' ? runUninstall() : runStatus();
      } catch (err) {
        result = {
          ok: false,
          lines: [
            { text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' },
          ],
        };
      }
      setReport(result);
      setRunning(false);
    }, 0);
  }, []);

  useInput((input, key) => {
    if (screen === 'menu') {
      if (input === 'i') runAction('install');
      else if (input === 'u') runAction('uninstall');
      else if (input === 's') runAction('status');
      else if (input === 'q' || key.escape) onBack();
      return;
    }
    // 'result' screen: ignore input while the (near-instant) action is running.
    if (running) return;
    if (input === 'b') {
      setScreen('menu');
      setAction(null);
      setReport(null);
    } else if (input === 'q' || key.escape) {
      onBack();
    }
  });

  if (screen === 'menu') {
    return (
      <Box flexDirection="column" gap={1}>
        <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
          <Text bold color="cyan">Worker Node — Service</Text>
          <Text dimColor>Manage the {SERVICE_UNIT} systemd user unit that keeps the worker node always on.</Text>
        </Box>
        <Box paddingX={2}>
          <Text dimColor>[i] install   [u] uninstall   [s] status   [q] back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Text bold color="cyan">Worker Node — Service — {action ? actionLabel(action) : ''}</Text>
        {running && (
          <Box>
            <Text color="cyan">
              <Spinner type="dots" /> running…
            </Text>
          </Box>
        )}
      </Box>

      {report && (
        <Box
          borderStyle={BOX_BORDER}
          borderColor={report.ok ? 'cyan' : 'red'}
          flexDirection="column"
          paddingX={2}
          paddingY={0}
        >
          {report.lines.map((l, i) => (
            <Text key={i} color={toneColor(l.tone)} dimColor={l.tone === 'dim'}>
              {l.text}
            </Text>
          ))}
        </Box>
      )}

      <Box paddingX={2}>
        <Text dimColor>{running ? 'please wait…' : '[b] back to menu   [q] back'}</Text>
      </Box>
    </Box>
  );
}
