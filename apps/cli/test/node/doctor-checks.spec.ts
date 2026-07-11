/**
 * test/node/doctor-checks.spec.ts
 *
 * Unit tests for node/doctor-checks.ts:
 *   - runApiAccessChecks: auth roundtrip / node-registration / manifest
 *     reachability against a fully stubbed ApiClient (no network).
 *   - checkDaemonLiveness: the three states a worker-node daemon can be in —
 *     not running, running (answers over IPC), and a stale pidfile left by a
 *     crashed daemon. Uses the same jest.unstable_mockModule('os', ...)
 *     pattern as test/reset.spec.ts so paths.ts resolves under a temp
 *     directory instead of the real ~/.memoriahub.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as net from 'net';
import * as actualOs from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock os.homedir() BEFORE importing anything that transitively imports
// paths.ts (doctor-checks.ts → daemon.ts / ipc-client.ts → paths.ts).
// ---------------------------------------------------------------------------

let _fakeHome = '';

jest.unstable_mockModule('os', () => ({
  ...actualOs,
  homedir: jest.fn(() => (_fakeHome !== '' ? _fakeHome : actualOs.homedir())),
}));

const { runApiAccessChecks, checkDaemonLiveness } = await import('../../src/node/doctor-checks.js');
const { encodeNdjson, NdjsonParser } = await import('../../src/node/ndjson.js');
const { nodePidPath, nodeSocketPath } = await import('../../src/paths.js');
const { ApiError } = await import('../../src/api.js');

// ---------------------------------------------------------------------------
// runApiAccessChecks
// ---------------------------------------------------------------------------

describe('runApiAccessChecks', () => {
  it('reports auth failure, skips node-registration (no nodeId), and reports manifest ok', async () => {
    const api = {
      get: jest.fn(async (p: string) => {
        if (p === '/api/auth/me') throw new ApiError(401, 'invalid token');
        throw new Error(`unexpected GET ${p}`);
      }),
      getModelManifest: jest.fn(async () => [{ name: 'm1' }]),
    } as unknown as import('../../src/api.js').ApiClient;

    const result = await runApiAccessChecks(api, undefined);

    expect(result.authOk).toBe(false);
    expect(result.authDetail).toMatch(/invalid token/);
    expect(result.nodeRegistrationOk).toBeNull();
    expect(result.nodeRegistrationDetail).toMatch(/not registered locally/);
    expect(result.manifestOk).toBe(true);
    expect(result.manifestDetail).toMatch(/1 model file/);
  });

  it('reports success for auth, node registration, and a non-empty manifest', async () => {
    const api = {
      get: jest.fn(async (p: string) => {
        if (p === '/api/auth/me') return { userId: 'u1' };
        if (p === '/api/nodes/node-123') return { id: 'node-123' };
        throw new Error(`unexpected GET ${p}`);
      }),
      getModelManifest: jest.fn(async () => [{ name: 'm1' }, { name: 'm2' }]),
    } as unknown as import('../../src/api.js').ApiClient;

    const result = await runApiAccessChecks(api, 'node-123');

    expect(result.authOk).toBe(true);
    expect(result.authDetail).toMatch(/jobs:write/);
    expect(result.nodeRegistrationOk).toBe(true);
    expect(result.nodeRegistrationDetail).toMatch(/found server-side/);
    expect(result.manifestOk).toBe(true);
    expect(result.manifestDetail).toMatch(/2 model file/);
  });

  it('treats a 404 node-registration lookup as a tolerated "not found", not a hard error', async () => {
    const api = {
      get: jest.fn(async (p: string) => {
        if (p === '/api/auth/me') return { userId: 'u1' };
        if (p === '/api/nodes/gone') throw new ApiError(404, 'not found');
        throw new Error(`unexpected GET ${p}`);
      }),
      getModelManifest: jest.fn(async () => []),
    } as unknown as import('../../src/api.js').ApiClient;

    const result = await runApiAccessChecks(api, 'gone');

    expect(result.nodeRegistrationOk).toBe(false);
    expect(result.nodeRegistrationDetail).toMatch(/HTTP 404/);
    expect(result.manifestOk).toBe(false);
    expect(result.manifestDetail).toMatch(/no model files/);
  });

  it('treats an unexpected node-registration error as "could not verify" (degrades, not a hard error)', async () => {
    const api = {
      get: jest.fn(async (p: string) => {
        if (p === '/api/auth/me') return { userId: 'u1' };
        if (p === '/api/nodes/n1') throw new Error('ECONNRESET');
        throw new Error(`unexpected GET ${p}`);
      }),
      getModelManifest: jest.fn(async () => {
        throw new Error('manifest endpoint down');
      }),
    } as unknown as import('../../src/api.js').ApiClient;

    const result = await runApiAccessChecks(api, 'n1');

    expect(result.nodeRegistrationOk).toBeNull();
    expect(result.nodeRegistrationDetail).toMatch(/could not verify/);
    expect(result.manifestOk).toBe(false);
    expect(result.manifestDetail).toMatch(/manifest endpoint down/);
  });
});

// ---------------------------------------------------------------------------
// checkDaemonLiveness
// ---------------------------------------------------------------------------

describe('checkDaemonLiveness', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-doctor-checks-'));
    _fakeHome = tmpDir;
  });

  afterEach(() => {
    _fakeHome = '';
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports "no daemon running" when neither a socket nor a pidfile exists', async () => {
    const result = await checkDaemonLiveness();
    expect(result.running).toBe(false);
    expect(result.stalePidfile).toBe(false);
    expect(result.pidInfo).toBeNull();
    expect(result.detail).toMatch(/no worker-node daemon running/);
  });

  it('reports a stale pidfile when the recorded pid is not alive', async () => {
    const pidPath = nodePidPath();
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    // PID far beyond any real process on Linux (max_pid default ~4194304,
    // and CI containers run far fewer processes) — reliably not alive.
    fs.writeFileSync(
      pidPath,
      JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString(), socketPath: nodeSocketPath() }),
    );

    const result = await checkDaemonLiveness();
    expect(result.running).toBe(false);
    expect(result.stalePidfile).toBe(true);
    expect(result.pidInfo?.pid).toBe(999_999_999);
    expect(result.detail).toMatch(/stale pidfile/);
  });

  it('reports the pidfile-alive-but-unresponsive-socket case distinctly from a stale pidfile', async () => {
    const pidPath = nodePidPath();
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    // Our own test process's pid is definitely alive, but nothing is
    // listening on the socket — simulates a wedged/starting daemon.
    fs.writeFileSync(
      pidPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), socketPath: nodeSocketPath() }),
    );

    const result = await checkDaemonLiveness();
    expect(result.running).toBe(false);
    expect(result.stalePidfile).toBe(false);
    expect(result.pidInfo?.pid).toBe(process.pid);
    expect(result.detail).toMatch(/IPC socket is not responding/);
  });

  it('reports running:true with a snapshot when a daemon answers over IPC', async () => {
    const socketPath = nodeSocketPath();
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });

    const fakeSnapshot = {
      kind: 'status',
      nodeId: 'node-1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      concurrency: 2,
      eligibleTypes: ['face_detection'],
    };

    const server = net.createServer((socket) => {
      const parser = new NdjsonParser();
      socket.on('data', (chunk) => {
        for (const res of parser.push(chunk)) {
          if (res.ok && (res.value as { cmd?: string }).cmd === 'status') {
            socket.write(encodeNdjson(fakeSnapshot));
          }
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    try {
      const result = await checkDaemonLiveness();
      expect(result.running).toBe(true);
      expect(result.stalePidfile).toBe(false);
      expect(result.snapshot).toMatchObject({ nodeId: 'node-1', concurrency: 2 });
      expect(result.detail).toMatch(/responding over IPC/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
    }
  });
});
