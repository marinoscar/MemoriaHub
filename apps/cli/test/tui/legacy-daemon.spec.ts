/**
 * test/tui/legacy-daemon.spec.ts  (RETRO-F4, #582)
 *
 * The adapter between the platform's `daemonAttachFeed` and the 1.3 worker daemon's
 * NDJSON protocol (PLATFORM-ADOPTION-SHIM RETRO-C10): frame translation per channel,
 * the connect function the feed calls, and the command helper. All against fakes.
 */
import { jest } from '@jest/globals';

import type { DaemonClient, DaemonMessage } from '../../src/node/ipc-client.js';
import {
  legacyDaemonConnect,
  parseLegacyEvent,
  sendDaemonCommand,
  translateLegacyFrame,
} from '../../src/tui/legacy-daemon.js';
import { nodeDashboardReducer } from '../../src/tui/node-dashboard-source.js';

function fakeClient(): { client: DaemonClient; sent: Record<string, unknown>[]; emit: (m: DaemonMessage) => void; close: () => void; closed: () => boolean } {
  const sent: Record<string, unknown>[] = [];
  let onMsg: (m: DaemonMessage) => void = () => undefined;
  let onClose: () => void = () => undefined;
  let closed = false;
  const client: DaemonClient = {
    send: (cmd) => void sent.push(cmd),
    onMessage: (cb) => void (onMsg = cb),
    onClose: (cb) => void (onClose = cb),
    waitFor: async (predicate) => {
      const reply: DaemonMessage = { kind: 'ack', cmd: 'drain' };
      if (predicate(reply)) return reply;
      throw new Error('no reply');
    },
    close: () => void (closed = true),
  };
  return { client, sent, emit: (m) => onMsg(m), close: () => onClose(), closed: () => closed };
}

describe('translateLegacyFrame', () => {
  it('node channel: snapshot, log-tail and event become platform messages', () => {
    expect(translateLegacyFrame('node', { kind: 'snapshot', nodeId: 'n1', concurrency: 2 })).toEqual({
      type: 'snapshot',
      snapshot: { nodeId: 'n1', concurrency: 2 },
    });
    const logs = translateLegacyFrame('node', { kind: 'log-tail', lines: ['a', 'b', 7] });
    expect(logs).toMatchObject({ type: 'log-tail', lines: [{ level: 'info', msg: 'a' }, { level: 'info', msg: 'b' }] });
    expect(translateLegacyFrame('node', { kind: 'event', ev: 'job:start', payload: { jobId: 'j' } })).toEqual({
      type: 'event',
      event: { ev: 'job:start', payload: { jobId: 'j' } },
    });
  });

  it('node channel ignores backup frames, and backup ignores node frames', () => {
    expect(translateLegacyFrame('node', { kind: 'backup-event', ev: 'x' })).toBeUndefined();
    expect(translateLegacyFrame('node', { kind: 'backup-status', configured: true })).toBeUndefined();
    expect(translateLegacyFrame('backup', { kind: 'event', ev: 'x' })).toBeUndefined();
    expect(translateLegacyFrame('backup', { kind: 'snapshot' })).toBeUndefined();
  });

  it('backup channel: backup-status is the snapshot and backup-event the event, tagged with the channel', () => {
    expect(translateLegacyFrame('backup', { kind: 'backup-status', configured: true })).toEqual({
      type: 'snapshot',
      snapshot: { configured: true },
      channel: 'backup',
    });
    expect(translateLegacyFrame('backup', { kind: 'backup-event', ev: 'backup:run-started', payload: { runId: 'r' } })).toEqual({
      type: 'event',
      event: { ev: 'backup:run-started', payload: { runId: 'r' } },
      channel: 'backup',
    });
  });

  it('an error frame surfaces on either channel; an ack is dropped', () => {
    expect(translateLegacyFrame('node', { kind: 'error', message: 'boom' })).toEqual({ type: 'error', message: 'boom' });
    expect(translateLegacyFrame('backup', { kind: 'error' })).toEqual({ type: 'error', message: 'daemon error' });
    expect(translateLegacyFrame('node', { kind: 'ack', cmd: 'drain' })).toBeUndefined();
  });
});

describe('parseLegacyEvent', () => {
  it('accepts an { ev, payload } frame and rejects anything else', () => {
    expect(parseLegacyEvent({ ev: 'idle', payload: 1 })).toEqual({ ev: 'idle', payload: 1 });
    expect(parseLegacyEvent({ ev: '' })).toBeUndefined();
    expect(parseLegacyEvent(null)).toBeUndefined();
    expect(parseLegacyEvent('idle')).toBeUndefined();
  });
});

describe('legacyDaemonConnect', () => {
  it('forwards translated frames and the close, and sends nothing for the node channel', async () => {
    const fake = fakeClient();
    const messages: unknown[] = [];
    const onClose = jest.fn();
    const connect = legacyDaemonConnect('node', (async () => fake.client) as never);
    const client = await connect({ socketPath: '/tmp/x.sock', onMessage: (m) => void messages.push(m), onClose });
    fake.emit({ kind: 'snapshot', nodeId: 'n1' });
    fake.emit({ kind: 'ack', cmd: 'x' });
    fake.close();
    expect(messages).toEqual([{ type: 'snapshot', snapshot: { nodeId: 'n1' } }]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fake.sent).toEqual([]);
    client.close();
    expect(fake.closed()).toBe(true);
  });

  it('asks a backup attach for the status the daemon only sends on request', async () => {
    const fake = fakeClient();
    const connect = legacyDaemonConnect('backup', (async () => fake.client) as never);
    await connect({ socketPath: '/tmp/x.sock', onMessage: () => undefined });
    expect(fake.sent).toEqual([{ cmd: 'backup-status' }]);
  });
});

describe('sendDaemonCommand', () => {
  it('sends one command on its own connection, returns the acknowledgement and closes', async () => {
    const fake = fakeClient();
    const reply = await sendDaemonCommand({ cmd: 'drain' }, { connect: (async () => fake.client) as never });
    expect(fake.sent).toEqual([{ cmd: 'drain' }]);
    expect(reply).toEqual({ kind: 'ack', cmd: 'drain' });
    expect(fake.closed()).toBe(true);
  });

  it('resolves null (and still closes) when the daemon does not answer', async () => {
    const fake = fakeClient();
    fake.client.waitFor = async () => {
      throw new Error('timed out');
    };
    expect(await sendDaemonCommand({ cmd: 'stop' }, { connect: (async () => fake.client) as never })).toBeNull();
    expect(fake.closed()).toBe(true);
  });
});

describe('nodeDashboardReducer', () => {
  it('is a pure fold: hydrate from a snapshot, reduce events, append the log tail, parse frames', () => {
    const reducer = nodeDashboardReducer(1, ['face_detection']);
    const initial = reducer.initial();
    expect(initial.concurrency).toBe(1);
    expect(reducer.initial()).not.toBe(initial);

    const hydrated = reducer.hydrate(initial, { nodeId: 'n', concurrency: 4, eligibleTypes: ['auto_tagging'], counters: { succeeded: 2 } });
    expect(hydrated.concurrency).toBe(4);
    expect(hydrated.counters.succeeded).toBe(2);

    const started = reducer.reduce(hydrated, { ev: 'job:start', payload: { jobId: 'j1', type: 'auto_tagging' }, atMs: 10 });
    expect(Object.keys(started.activeJobs)).toEqual(['j1']);
    expect(Object.keys(hydrated.activeJobs)).toEqual([]);

    const logged = reducer.log!(started, [{ ts: 't', level: 'info', msg: 'daemon booted' }]);
    expect(logged.log.map((l) => l.msg)).toEqual(['daemon booted']);

    expect(reducer.parseEvent({ ev: 'idle', payload: {} })).toMatchObject({ ev: 'idle' });
    expect(reducer.parseEvent('garbage')).toBeUndefined();
  });
});
