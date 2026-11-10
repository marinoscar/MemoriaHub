/**
 * backup/socket-path.ts - where the backup control socket lives (RETRO-C10, #616).
 *
 * The 1.3 daemon served the `backup-*` commands on its own socket (`node.sock`). The platform
 * daemon's socket speaks the platform protocol (status, set-concurrency, drain, stop, heap-snapshot;
 * a channel is read-only), so the backup commands got a socket of their own, next to it, that is
 * served by the same process while a backup root is bound.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { nodeStateDirectory } from '../executors/state-dir.js';

export function backupSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (os.platform() === 'win32') return '\\\\.\\pipe\\memoriahub-backup';
  return path.join(nodeStateDirectory(env), 'backup.sock');
}
