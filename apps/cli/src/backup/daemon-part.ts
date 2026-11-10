/**
 * backup/daemon-part.ts - the backup engine inside the worker process (RETRO-C10, #616).
 *
 * The 1.3 daemon hosted the backup engine next to the enrichment engine and served both on one
 * socket. On the platform daemon this is split in two, both started from a worker runtime hook
 * (`registerWorkerRuntimeHook`, which runs in the daemon and in a foreground worker):
 *
 *   - the events and the snapshot are the daemon CHANNEL `backup` (`registerDaemonChannel`): the
 *     dashboards attach to it read-only through `daemonAttachFeed({ channel: 'backup' })`;
 *   - the commands (`backup-status`, `backup-run-now`, `backup-cancel`, `backup-set-rate`) are served
 *     on the backup control socket (./socket-path.ts), with the frames the 1.3 daemon used, because a
 *     platform channel cannot take commands.
 *
 * PLATFORM-ADOPTION-SHIM(RETRO-SEAM-DAEMON-COMMANDS, EAB#1145): the control socket exists because a
 * channel cannot take commands.
 *
 * Activation is the 1.3 rule: a backup root bound in the settings (`backup.root` + `backup.nodeId`).
 * Nothing here ever throws into worker start.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';

import { registerDaemonChannel } from '@marinoscar/platform-cli/node';

import { loadConfig } from '../config.js';
import { getDb } from '../db/database.js';
import { SettingsRepo } from '../repo/settings.js';
import { readVersion as cliVersion } from '../version.js';
import { BackupHost } from './backup-host.js';
import { BACKUP_HOST_EVENT } from './events.js';
import { createBackupLogger, type BackupLogger } from './logger.js';
import { NdjsonParser, encodeNdjson } from './ndjson.js';
import { backupSocketPath } from './socket-path.js';

/** Handles one control frame; pure over the host so it is a plain test case. */
export function handleBackupCommand(
  host: Pick<BackupHost, 'getSnapshot' | 'startRun' | 'cancel' | 'setRate'> | undefined,
  logger: Pick<BackupLogger, 'info'>,
  msg: Record<string, unknown>,
): Record<string, unknown> {
  const cmd = msg['cmd'];
  if (cmd === 'backup-status') {
    return host
      ? { kind: 'backup-status', ...host.getSnapshot() }
      : { kind: 'backup-status', configured: false, running: null, lastRun: null, checkpoint: null, counters: null, rate: null };
  }
  if (host === undefined) {
    return {
      kind: 'error',
      cmd,
      code: 'not-configured',
      message: 'backup is not configured on this worker (run `memoriahub backup init` and restart the node)',
    };
  }
  switch (cmd) {
    case 'backup-run-now': {
      try {
        const kind = msg['kind'] === 'reconcile' ? ('reconcile' as const) : ('incremental' as const);
        host.startRun('manual', kind);
        logger.info('backup run started via control socket', { kind });
        return { kind: 'ack', cmd };
      } catch (err) {
        const busy = (err as { code?: unknown })?.code === 'busy';
        return { kind: 'error', cmd, ...(busy ? { code: 'busy' } : {}), message: err instanceof Error ? err.message : String(err) };
      }
    }
    case 'backup-cancel': {
      const cancelled = host.cancel();
      if (cancelled) logger.info('backup run cancel requested via control socket');
      return { kind: 'ack', cmd, cancelled };
    }
    case 'backup-set-rate': {
      const update: { concurrency?: number; maxMbps?: number } = {};
      if (msg['concurrency'] !== undefined) {
        const value = Number(msg['concurrency']);
        if (!Number.isInteger(value) || value < 1 || value > 32) {
          return { kind: 'error', cmd, message: 'backup-set-rate requires an integer concurrency between 1 and 32' };
        }
        update.concurrency = value;
      }
      if (msg['maxMbps'] !== undefined) {
        const value = Number(msg['maxMbps']);
        if (!Number.isFinite(value) || value < 0) {
          return { kind: 'error', cmd, message: 'backup-set-rate requires a non-negative maxMbps (0 = unlimited)' };
        }
        update.maxMbps = value;
      }
      if (update.concurrency === undefined && update.maxMbps === undefined) {
        return { kind: 'error', cmd, message: 'backup-set-rate requires concurrency and/or maxMbps' };
      }
      const effective = host.setRate(update);
      logger.info('backup rate changed via control socket', { ...effective });
      return { kind: 'ack', cmd, ...effective };
    }
    default:
      return { kind: 'error', message: `unknown command: ${String(cmd)}` };
  }
}

/** Listens on the control socket; resolves with a stop function. */
export async function serveBackupControl(
  host: BackupHost | undefined,
  logger: BackupLogger,
  socketPath: string = backupSocketPath(),
): Promise<() => Promise<void>> {
  const isWindows = os.platform() === 'win32';
  if (!isWindows) fs.mkdirSync(socketPath.replace(/[^/]+$/, ''), { recursive: true });
  if (!isWindows && fs.existsSync(socketPath)) {
    const live = await new Promise<boolean>((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => (probe.destroy(), resolve(true)));
      probe.once('error', () => resolve(false));
    });
    if (live) throw new Error(`backup control socket ${socketPath} is live: another worker owns the backup`);
    fs.unlinkSync(socketPath);
  }
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setEncoding('utf-8');
    socket.on('error', () => undefined);
    socket.on('close', () => clients.delete(socket));
    const parser = new NdjsonParser();
    socket.on('data', (chunk) => {
      for (const res of parser.push(chunk)) {
        const reply = res.ok
          ? handleBackupCommand(host, logger, res.value as Record<string, unknown>)
          : { kind: 'error', message: `malformed command: ${res.error}` };
        socket.write(encodeNdjson(reply));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  if (!isWindows) {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
  return () =>
    new Promise((resolve) => {
      for (const c of clients) c.destroy();
      server.close(() => {
        if (!isWindows) {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            /* gone */
          }
        }
        resolve();
      });
    });
}

/**
 * Starts the backup host when a root is bound. Returns `undefined` when there is nothing to host.
 * Never throws.
 */
export async function startBackupInWorker(): Promise<{ host: BackupHost; stop: () => Promise<void> } | undefined> {
  let logger: BackupLogger | undefined;
  try {
    const cfg = loadConfig();
    if (!cfg) return undefined;
    const settings = new SettingsRepo(getDb());
    const root = settings.backupRoot();
    const nodeId = settings.backupNodeId();
    if (!root || !nodeId) return undefined;

    logger = createBackupLogger();
    const host = new BackupHost(
      {
        serverUrl: cfg.serverUrl,
        pat: cfg.pat,
        root,
        nodeId,
        ...(cfg.node?.name !== undefined ? { nodeName: cfg.node.name } : {}),
        cliVersion: cliVersion(),
      },
      { settings, logger, retry: settings.retryConfig(), cooldown: settings.cooldownConfig() },
    );
    host.startScheduler();
    registerDaemonChannel({
      id: 'backup',
      snapshot: () => host.getSnapshot(),
      events: host,
      eventName: BACKUP_HOST_EVENT,
    });
    const stopControl = await serveBackupControl(host, logger);
    logger.info('backup hosting active', { root, nodeId });
    return {
      host,
      stop: async () => {
        host.stopScheduler();
        await stopControl();
      },
    };
  } catch (err) {
    logger?.warn('backup hosting unavailable', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
