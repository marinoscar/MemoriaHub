/**
 * node/ipc-client.ts — Client side of the worker-node daemon IPC socket.
 *
 * Small NDJSON-framed client used by `node status|stop|set-concurrency|logs`
 * (and a future TUI attach mode) to talk to a running daemon host
 * (see node/daemon.ts for the protocol).
 */

import * as net from 'node:net';
import { backupSocketPath } from './socket-path.js';
import { NdjsonParser, encodeNdjson } from './ndjson.js';

/** Any frame received from the daemon (kind discriminates). */
export interface DaemonMessage {
  kind: string;
  [key: string]: unknown;
}

export interface DaemonClient {
  /** Send one command frame, e.g. { cmd: 'status' }. */
  send(cmd: Record<string, unknown>): void;
  /** Subscribe to every incoming frame (snapshot, event, ack, …). */
  onMessage(cb: (msg: DaemonMessage) => void): void;
  /** Subscribe to connection close. */
  onClose(cb: () => void): void;
  /**
   * Resolve with the first frame matching `predicate`, or reject after
   * `timeoutMs` (default 5000) or if the connection closes first.
   */
  waitFor(predicate: (msg: DaemonMessage) => boolean, timeoutMs?: number): Promise<DaemonMessage>;
  close(): void;
}

/** Connect to the daemon socket; rejects when nothing is listening. */
export function connectToDaemon(
  socketPath: string = backupSocketPath(),
  timeoutMs = 2000,
): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to daemon socket ${socketPath}`));
    }, timeoutMs);
    connectTimer.unref?.();

    socket.once('error', (err) => {
      clearTimeout(connectTimer);
      reject(err);
    });

    socket.once('connect', () => {
      clearTimeout(connectTimer);
      socket.removeAllListeners('error');

      const parser = new NdjsonParser();
      const messageCbs = new Set<(msg: DaemonMessage) => void>();
      const closeCbs = new Set<() => void>();
      let isClosed = false;

      socket.on('data', (chunk) => {
        for (const res of parser.push(chunk)) {
          if (!res.ok) continue; // tolerate garbage from a mismatched version
          const msg = res.value as DaemonMessage;
          if (msg === null || typeof msg !== 'object' || typeof msg.kind !== 'string') continue;
          for (const cb of messageCbs) cb(msg);
        }
      });
      const fireClose = (): void => {
        if (isClosed) return;
        isClosed = true;
        for (const cb of closeCbs) cb();
      };
      socket.on('close', fireClose);
      socket.on('error', fireClose);

      const client: DaemonClient = {
        send: (cmd) => {
          try {
            socket.write(encodeNdjson(cmd));
          } catch {
            /* connection already gone; waitFor/onClose surfaces it */
          }
        },
        onMessage: (cb) => {
          messageCbs.add(cb);
        },
        onClose: (cb) => {
          if (isClosed) {
            cb();
            return;
          }
          closeCbs.add(cb);
        },
        waitFor: (predicate, waitMs = 5000) =>
          new Promise<DaemonMessage>((res, rej) => {
            const timer = setTimeout(() => {
              messageCbs.delete(handler);
              rej(new Error('timed out waiting for daemon reply'));
            }, waitMs);
            timer.unref?.();
            const handler = (msg: DaemonMessage): void => {
              if (!predicate(msg)) return;
              clearTimeout(timer);
              messageCbs.delete(handler);
              res(msg);
            };
            messageCbs.add(handler);
            closeCbs.add(() => {
              clearTimeout(timer);
              messageCbs.delete(handler);
              rej(new Error('daemon connection closed'));
            });
          }),
        close: () => {
          socket.destroy();
        },
      };

      resolve(client);
    });
  });
}

/** Probe whether a daemon is accepting connections on the socket. */
export async function isDaemonRunning(socketPath: string = backupSocketPath()): Promise<boolean> {
  try {
    const client = await connectToDaemon(socketPath, 500);
    client.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends one command to the backup control socket over a short-lived connection and resolves with the
 * acknowledgement (or error) frame, or `null` when none arrives in time.
 */
export async function sendBackupCommand(
  command: Record<string, unknown>,
  options: { socketPath?: string | undefined; timeoutMs?: number | undefined; connect?: typeof connectToDaemon } = {},
): Promise<DaemonMessage | null> {
  let client: DaemonClient;
  try {
    client = await (options.connect ?? connectToDaemon)(options.socketPath, 2000);
  } catch {
    return null;
  }
  try {
    client.send(command);
    return await client.waitFor((m) => m.kind === 'ack' || m.kind === 'error', options.timeoutMs ?? 2000);
  } catch {
    return null;
  } finally {
    client.close();
  }
}
