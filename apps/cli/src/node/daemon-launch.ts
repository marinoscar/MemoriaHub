/**
 * node/daemon-launch.ts — Parameterized daemon launcher.
 *
 * `node start --daemon` (see commands/node.ts's `startCmd()`) re-spawns the
 * CLI itself by forwarding `process.argv` verbatim minus the `--daemon` flag.
 * That trick only works when the current process really was invoked as
 * `memoriahub node start --daemon` — it breaks for any other entry point
 * (e.g. a TUI screen invoked via a different argv) that wants to launch a
 * detached worker-node daemon programmatically.
 *
 * This module is the argv-independent counterpart: it builds the `node
 * start` argument list explicitly from parameters instead of forwarding
 * `process.argv`, so callers like a future TUI "start as daemon" screen can
 * spawn a daemon without depending on how they themselves were invoked.
 *
 * Deliberately separate from `daemon.ts` (the IPC *host* side — pidfile +
 * socket server for an already-running engine) — this file is only about
 * launching a new detached process and checking/waiting for one to come up.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logsDir } from '../paths.js';
import { nodeLogPath } from './logger.js';
import { readPidFile, isPidAlive } from './daemon.js';
import { isDaemonRunning } from './ipc-client.js';

export interface SpawnDaemonOptions {
  /** Forwarded as `--concurrency <n>` when set. */
  concurrency?: number;
  /** Forwarded as `--types <csv>` when set (comma-joined). */
  types?: string[];
  /** Forwarded as `--poll <ms>` when set. */
  poll?: number;
}

export interface SpawnedDaemonResult {
  /** PID of the detached daemon process. */
  pid: number;
  /** Path of the redirected stdout/stderr file (process-level output). */
  outPath: string;
  /** Path of the structured JSONL worker-node log. */
  logPath: string;
}

/**
 * Spawn `memoriahub node start` as a detached background process, mirroring
 * the `--daemon` branch of `startCmd()` in commands/node.ts but building its
 * argv explicitly from `opts` instead of forwarding `process.argv` — safe to
 * call from any entry point (e.g. a TUI screen), not just `node start
 * --daemon` itself.
 */
export function spawnNodeStartDaemon(opts: SpawnDaemonOptions = {}): SpawnedDaemonResult {
  const outPath = path.join(logsDir(), 'node.out.log');
  const logFd = fs.openSync(outPath, 'a');

  const args = ['node', 'start'];
  if (opts.concurrency !== undefined) {
    args.push('--concurrency', String(opts.concurrency));
  }
  if (opts.types !== undefined) {
    args.push('--types', opts.types.join(','));
  }
  if (opts.poll !== undefined) {
    args.push('--poll', String(opts.poll));
  }

  const child = spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  return { pid: child.pid!, outPath, logPath: nodeLogPath() };
}

export interface AlreadyRunningCheck {
  running: boolean;
  pid?: number;
  via?: 'pidfile' | 'ipc';
}

/**
 * Check whether a worker-node daemon is already running, via the same
 * pidfile-then-IPC guard `startCmd()` runs up front — refactored out so it
 * can be reused from a non-CLI caller (e.g. a React/Ink TUI screen) that must
 * never print to stdout or call `process.exit`.
 */
export async function checkNodeAlreadyRunning(): Promise<AlreadyRunningCheck> {
  const pidInfo = readPidFile();
  if (pidInfo && isPidAlive(pidInfo.pid)) {
    return { running: true, pid: pidInfo.pid, via: 'pidfile' };
  }
  if (await isDaemonRunning()) {
    return { running: true, via: 'ipc' };
  }
  return { running: false };
}

/** Promise-based delay, used by waitForDaemonReady's polling loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Poll `isDaemonRunning()` every `intervalMs` until it reports true or
 * `timeoutMs` elapses. Used right after `spawnNodeStartDaemon()` to confirm
 * the detached process actually came up and started hosting its IPC socket,
 * without busy-looping.
 */
export async function waitForDaemonReady(
  timeoutMs = 8000,
  intervalMs = 300,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isDaemonRunning()) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}
