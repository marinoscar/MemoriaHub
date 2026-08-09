/**
 * backup/run-via-daemon.ts — `backup run` delegation over the daemon IPC
 * channel (issue #318, epic #308).
 *
 * When a worker-node daemon is running, `backup run` does NOT start an
 * embedded engine (two engines would fight over the run lock and the daemon
 * owns the scheduler anyway). Instead it connects to the IPC socket, sends
 * `backup-run-now`, and streams the daemon's `backup-event` frames into the
 * SAME headless renderer the embedded path uses — the terminal output is
 * indistinguishable. `--embedded` forces the in-process engine.
 *
 * Frame discipline: everything before our command's ack is ignored (a
 * previous or scheduled run's tail events must not be attributed to this
 * invocation); once accepted, `backup-event` frames are re-emitted on a local
 * BackupTypedEmitter proxy until the run-finished event arrives.
 */

import type { DaemonClient, DaemonMessage } from '../node/ipc-client.js';
import {
  BACKUP_EV,
  BackupTypedEmitter,
  type BackupEventName,
  type RunFinishedPayload,
} from './events.js';
import type { BackupRunOutcome } from './backup-engine.js';

/** The daemon rejected the run because one is already active. */
export class DaemonBackupBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonBackupBusyError';
  }
}

/**
 * The daemon has no BackupHost (started before `backup init` bound a root).
 * The caller falls back to the embedded engine.
 */
export class DaemonBackupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonBackupUnavailableError';
  }
}

/** Delegate to the daemon unless --embedded was passed or no daemon is up. */
export function shouldDelegateToDaemon(embedded: boolean, daemonUp: boolean): boolean {
  return !embedded && daemonUp;
}

const VALID_EVENTS = new Set<string>(Object.values(BACKUP_EV));

export interface RunViaDaemonOptions {
  /** Attach the renderer to the event proxy BEFORE the run is requested. */
  attachRenderer: (emitter: BackupTypedEmitter) => void;
  /** Timeout for the daemon to accept/reject the run (default 10 s). */
  acceptTimeoutMs?: number;
}

/**
 * Request a manual run from the daemon and stream its events until finished.
 * Resolves with an outcome shaped like the embedded engine's (runId is not
 * carried over IPC frames and is reported as '(daemon)').
 */
export function runViaDaemon(
  client: DaemonClient,
  opts: RunViaDaemonOptions,
): Promise<BackupRunOutcome> {
  const proxy = new BackupTypedEmitter();
  opts.attachRenderer(proxy);

  return new Promise<BackupRunOutcome>((resolve, reject) => {
    let accepted = false;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(acceptTimer);
      fn();
    };

    const acceptTimer = setTimeout(() => {
      settle(() => reject(new Error('timed out waiting for the daemon to accept the backup run')));
    }, opts.acceptTimeoutMs ?? 10_000);
    acceptTimer.unref?.();

    client.onMessage((msg: DaemonMessage) => {
      if (!accepted) {
        if ((msg.kind === 'ack' || msg.kind === 'error') && msg['cmd'] === 'backup-run-now') {
          if (msg.kind === 'error') {
            const message = String(msg['message'] ?? 'daemon rejected the backup run');
            settle(() =>
              reject(
                msg['code'] === 'busy'
                  ? new DaemonBackupBusyError(message)
                  : msg['code'] === 'not-configured'
                    ? new DaemonBackupUnavailableError(message)
                    : new Error(message),
              ),
            );
            return;
          }
          clearTimeout(acceptTimer);
          accepted = true;
        }
        // Everything before our ack — including a previous run's tail
        // events — is deliberately ignored.
        return;
      }

      if (msg.kind !== 'backup-event') return;
      const ev = msg['ev'];
      if (typeof ev !== 'string' || !VALID_EVENTS.has(ev)) return;
      const payload = msg['payload'];
      proxy.emit(ev as BackupEventName, payload as never);

      if (ev === BACKUP_EV.RUN_FINISHED) {
        const fin = payload as RunFinishedPayload;
        settle(() =>
          resolve({
            runId: '(daemon)',
            status: fin.status,
            stats: fin.stats,
            ...(fin.error !== undefined ? { error: fin.error } : {}),
          }),
        );
      }
    });

    client.onClose(() => {
      settle(() => reject(new Error('daemon connection closed before the backup run finished')));
    });

    client.send({ cmd: 'backup-run-now' });
  });
}
