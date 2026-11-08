// PLATFORM-ADOPTION-SHIM(RETRO-C10): the worker daemon is still the 1.3 one (`memoriahub node
// start --daemon`), whose NDJSON socket protocol is not the platform's. This adapter lets the
// platform's `daemonAttachFeed` attach to it; it is deleted when the node group moves onto the
// platform engine (the daemon then speaks the platform protocol and `registerDaemonChannel`
// publishes the backup channel).

/**
 * tui/legacy-daemon.ts — the 1.3 daemon protocol seen through the platform's dashboard feeds
 * (RETRO-F4, #582). Ink-free.
 *
 * The platform's `daemonAttachFeed({ socketPath, channel, connect })` is read-only and speaks the
 * platform protocol (`{ type: 'snapshot' | 'log-tail' | 'event', channel?, ... }`). MemoriaHub's
 * daemon (src/node/daemon.ts) greets a client with `{ kind: 'snapshot', ...fields }` and
 * `{ kind: 'log-tail', lines: string[] }`, broadcasts `{ kind: 'event', ev, payload }` (node) and
 * `{ kind: 'backup-event', ev, payload }` (backup), and answers `{ cmd: 'backup-status' }` with
 * `{ kind: 'backup-status', ... }`. `legacyDaemonConnect` is the `connect` option that translates
 * one into the other, so the dashboards use the platform source unchanged.
 *
 * Commands (drain, stop, set-concurrency, backup-run-now, ...) are not part of an attach feed (it
 * never sends a frame). `sendDaemonCommand` opens a short-lived second connection for each one;
 * the daemon broadcasts the resulting events to every attached client, including the dashboard.
 */
import type { LogRecord } from '@marinoscar/platform-cli/tui';

import { connectToDaemon as connectLegacy, type DaemonMessage as LegacyMessage } from '../node/ipc-client.js';

/** The two engines a 1.3 daemon hosts. */
export type LegacyChannel = 'node' | 'backup';

/** The platform's message shape (just what the attach feed reads). */
export type PlatformDaemonMessage =
  | { type: 'snapshot'; snapshot: unknown; channel?: string }
  | { type: 'log-tail'; lines: LogRecord[]; channel?: string }
  | { type: 'event'; event: unknown; channel?: string }
  | { type: 'error'; message: string }
  | { type: 'ack'; command: string };

/** What a dashboard's `parseEvent` receives for one 1.3 `event` / `backup-event` frame. */
export interface LegacyEventFrame {
  ev: string;
  payload: unknown;
}

function withoutKind(msg: LegacyMessage): Record<string, unknown> {
  const { kind: _kind, ...rest } = msg;
  return rest;
}

function toLogRecords(lines: unknown): LogRecord[] {
  if (!Array.isArray(lines)) return [];
  const ts = new Date().toISOString();
  return lines.filter((l): l is string => typeof l === 'string').map((msg) => ({ ts, level: 'info' as const, msg }));
}

/**
 * Translates one 1.3 frame for `channel`; `undefined` drops it (another channel's frame, an ack).
 * Pure, so it is a plain test case.
 */
export function translateLegacyFrame(channel: LegacyChannel, msg: LegacyMessage): PlatformDaemonMessage | undefined {
  const tag = channel === 'node' ? {} : { channel };
  switch (msg.kind) {
    case 'snapshot':
      return channel === 'node' ? { type: 'snapshot', snapshot: withoutKind(msg) } : undefined;
    case 'log-tail':
      return channel === 'node' ? { type: 'log-tail', lines: toLogRecords(msg['lines']) } : undefined;
    case 'event':
      return channel === 'node'
        ? { type: 'event', event: { ev: String(msg['ev'] ?? ''), payload: msg['payload'] } satisfies LegacyEventFrame }
        : undefined;
    case 'backup-status':
      return channel === 'backup' ? { type: 'snapshot', snapshot: withoutKind(msg), ...tag } : undefined;
    case 'backup-event':
      return channel === 'backup'
        ? { type: 'event', event: { ev: String(msg['ev'] ?? ''), payload: msg['payload'] } satisfies LegacyEventFrame, ...tag }
        : undefined;
    case 'error':
      return { type: 'error', message: typeof msg['message'] === 'string' ? msg['message'] : 'daemon error' };
    default:
      return undefined;
  }
}

/** Parses a translated `event` frame; `undefined` for anything else. */
export function parseLegacyEvent(frame: unknown): LegacyEventFrame | undefined {
  if (frame === null || typeof frame !== 'object') return undefined;
  const { ev, payload } = frame as { ev?: unknown; payload?: unknown };
  return typeof ev === 'string' && ev.length > 0 ? { ev, payload } : undefined;
}

/** The subset of the platform's `ConnectOptions` / `DaemonClient` the attach feed uses. */
interface ConnectOptionsLike {
  socketPath: string;
  onMessage: (message: never) => void;
  onClose?: (() => void) | undefined;
  timeoutMs?: number | undefined;
}

/**
 * The `connect` option of `daemonAttachFeed` for a 1.3 daemon. For the backup channel it also asks for
 * the status the daemon only sends on request.
 */
export function legacyDaemonConnect(channel: LegacyChannel, connect: typeof connectLegacy = connectLegacy) {
  return async (options: ConnectOptionsLike): Promise<{ send: (command: never) => void; close: () => void }> => {
    const client = await connect(options.socketPath, options.timeoutMs);
    client.onMessage((msg) => {
      const translated = translateLegacyFrame(channel, msg);
      if (translated) options.onMessage(translated as never);
    });
    client.onClose(() => options.onClose?.());
    if (channel === 'backup') client.send({ cmd: 'backup-status' });
    return { send: () => undefined, close: () => client.close() };
  };
}

/**
 * Sends one command to the daemon over a short-lived connection and resolves with the daemon's
 * acknowledgement (or error) frame, or `null` when none arrives in time.
 */
export async function sendDaemonCommand(
  command: Record<string, unknown>,
  options: { socketPath?: string | undefined; timeoutMs?: number | undefined; connect?: typeof connectLegacy } = {},
): Promise<LegacyMessage | null> {
  const client = await (options.connect ?? connectLegacy)(options.socketPath, 2000);
  try {
    client.send(command);
    return await client.waitFor((m) => m.kind === 'ack' || m.kind === 'error', options.timeoutMs ?? 2000);
  } catch {
    return null;
  } finally {
    client.close();
  }
}
