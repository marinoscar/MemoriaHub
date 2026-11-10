/**
 * test/tui/backup-dashboard.spec.tsx  (RETRO-F4, #582)
 *
 * The backup dashboard on the platform dashboard pattern, with the daemon probe mocked so no
 * socket is touched: an unconfigured machine gets guidance; a configured one with no daemon runs
 * embedded; with a daemon whose backup channel answers, the screen attaches (the platform attach
 * feed over the 1.3 adapter, with a fake client serving the status) and shows the daemon state.
 */
import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { render, cleanup } from 'ink-testing-library';

import type { DaemonClient, DaemonMessage } from '../../src/backup/ipc-client.js';
import { waitForFrame } from './wait-for.js';

const isDaemonRunningMock = jest.fn<() => Promise<boolean>>(async () => false);
const connectToDaemonMock = jest.fn<(...args: unknown[]) => Promise<DaemonClient>>();
jest.unstable_mockModule('../../src/backup/ipc-client.js', () => ({
  isDaemonRunning: isDaemonRunningMock,
  connectToDaemon: connectToDaemonMock,
  sendBackupCommand: jest.fn(async () => null),
}));

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-backup-dash-'));
process.env['MEMORIAHUB_STATE_DIR'] = state;

const { BackupDashboard } = await import('../../src/tui/BackupDashboard.js');
const { getDb } = await import('../../src/db/database.js');
const { SettingsRepo } = await import('../../src/repo/settings.js');

const CONFIG = { serverUrl: 'http://server.example.test', pat: 'tok' };

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** A fake daemon client: answers backup-status with a snapshot and then stays quiet. */
function daemonClient(running: boolean): DaemonClient {
  let onMsg: (m: DaemonMessage) => void = () => undefined;
  return {
    send: (cmd) => {
      if (cmd['cmd'] === 'backup-status') {
        queueMicrotask(() =>
          onMsg({
            kind: 'backup-status',
            configured: true,
            running: running ? { trigger: 'scheduled', startedAt: new Date().toISOString() } : null,
            lastRun: null,
            checkpoint: null,
            counters: { totalItems: 12, totalBytes: 2048, present: 12, failed: 0, quarantined: 0, trashed: 0 },
            rate: { concurrency: 2, maxMbps: 0 },
          }),
        );
      }
    },
    onMessage: (cb) => void (onMsg = cb),
    onClose: () => undefined,
    waitFor: async (predicate) => {
      const reply: DaemonMessage = {
        kind: 'backup-status',
        configured: true,
        running: running ? { trigger: 'scheduled', startedAt: new Date().toISOString() } : null,
        lastRun: null,
        checkpoint: null,
        counters: { totalItems: 12, totalBytes: 2048, present: 12, failed: 0, quarantined: 0, trashed: 0 },
        rate: { concurrency: 2, maxMbps: 0 },
      };
      if (predicate(reply)) return reply;
      throw new Error('no reply');
    },
    close: () => undefined,
  };
}

afterEach(() => cleanup());

describe('BackupDashboard', () => {
  it('guides a machine with no backup root bound', async () => {
    const { lastFrame } = render(<BackupDashboard config={CONFIG} onBack={() => undefined} />);
    expect(stripAnsi(lastFrame()!)).toContain('No backup root is configured on this machine.');
    expect(stripAnsi(lastFrame()!)).toContain('memoriahub backup init');
  });

  describe('with a backup root bound', () => {
    beforeAll(() => {
      const settings = new SettingsRepo(getDb());
      settings.setBackupRoot(path.join(state, 'backup-root'));
      settings.setBackupNodeId('node-1');
    });

    it('runs embedded when no daemon is running', async () => {
      isDaemonRunningMock.mockResolvedValue(false);
      const { lastFrame } = render(<BackupDashboard config={CONFIG} onBack={() => undefined} />);
      const plain = stripAnsi(await waitForFrame(lastFrame, (f) => f.includes('embedded (no daemon)')));
      expect(plain).toContain('State: idle');
      expect(plain).toContain('[r] run now');
    });

    it('attaches to a running daemon and shows its catalog and rate', async () => {
      isDaemonRunningMock.mockResolvedValue(true);
      connectToDaemonMock.mockImplementation(async () => daemonClient(false));
      const { lastFrame } = render(<BackupDashboard config={CONFIG} onBack={() => undefined} />);
      const plain = stripAnsi(await waitForFrame(lastFrame, (f) => f.includes('Catalog') && f.includes('12 item(s)')));
      expect(plain).toContain('attached to daemon');
      expect(plain).toContain('concurrency 2');
    });

    it('shows a run the daemon already has in flight', async () => {
      isDaemonRunningMock.mockResolvedValue(true);
      connectToDaemonMock.mockImplementation(async () => daemonClient(true));
      const { lastFrame } = render(<BackupDashboard config={CONFIG} onBack={() => undefined} />);
      const plain = stripAnsi(await waitForFrame(lastFrame, (f) => f.includes('State: running')));
      expect(plain).toContain('attached to daemon');
    });

    it('Esc / q goes back', async () => {
      isDaemonRunningMock.mockResolvedValue(false);
      const onBack = jest.fn();
      const { lastFrame, stdin } = render(<BackupDashboard config={CONFIG} onBack={onBack} />);
      await waitForFrame(lastFrame, (f) => f.includes('embedded (no daemon)'));
      stdin.write('q');
      await waitForFrame(() => String(onBack.mock.calls.length), (n) => n === '1');
    });
  });
});
