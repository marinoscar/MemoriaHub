/**
 * executors/state-dir.ts - the worker's state directory, as the platform computes it
 * (`MEMORIAHUB_STATE_DIR`, else `~/.memoriahub/node`). The platform does not export its path helper.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { workerEnv } from '@marinoscar/platform-cli/node';

export function nodeStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[workerEnv().stateDir]?.trim();
  return override !== undefined && override !== '' ? override : path.join(os.homedir(), '.memoriahub', 'node');
}

/** The platform daemon's socket: `<node state dir>/node.sock` (a named pipe on Windows). */
export function nodeSocketPathOf(env: NodeJS.ProcessEnv = process.env): string {
  if (os.platform() === 'win32') return '\\\\.\\pipe\\memoriahub-node';
  return path.join(nodeStateDirectory(env), 'node.sock');
}
