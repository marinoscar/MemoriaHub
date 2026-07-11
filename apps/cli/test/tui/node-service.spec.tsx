/**
 * test/tui/node-service.spec.tsx
 *
 * Tests for NodeService.tsx (install/uninstall/status of the systemd user
 * unit), with `node:child_process`'s spawnSync MOCKED throughout — the real
 * `systemctl` binary is never invoked during this test run. `node:os`'s
 * `homedir`/`platform` are also mocked (same pattern as
 * test/node/doctor-checks.spec.ts) so any real filesystem writes the action
 * handlers perform (unit-file write/unlink) land under a throwaway temp
 * directory instead of the real `~/.config/systemd/user/`.
 *
 * Mock modules must be registered with jest.unstable_mockModule BEFORE the
 * module under test is imported, so both are dynamically imported via
 * `await import(...)` at module scope (ESM + ts-jest convention used
 * elsewhere in this test suite).
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as osActual from 'os';
import * as path from 'path';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

// ---------------------------------------------------------------------------
// Mocks (registered before importing the module under test)
// ---------------------------------------------------------------------------

interface SpawnSyncReturn {
  status: number | null;
  stdout: string;
  stderr: string;
}

const spawnSyncMock = jest.fn<(...args: unknown[]) => SpawnSyncReturn>();

jest.unstable_mockModule('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

let fakeHome = '';
let fakePlatform: string | null = null;

jest.unstable_mockModule('node:os', () => ({
  ...osActual,
  homedir: jest.fn(() => (fakeHome !== '' ? fakeHome : osActual.homedir())),
  platform: jest.fn(() => fakePlatform ?? osActual.platform()),
}));

const {
  NodeService,
  hasUserSystemd,
  runSystemctlUser,
  runInstall,
  runUninstall,
  runStatus,
  unitFileContent,
  systemdUserDir,
  SERVICE_UNIT,
} = await import('../../src/tui/NodeService.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ok(stdout = '', stderr = ''): SpawnSyncReturn {
  return { status: 0, stdout, stderr };
}

function fail(status = 1, stdout = '', stderr = ''): SpawnSyncReturn {
  return { status, stdout, stderr };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  fakeHome = fs.mkdtempSync(path.join(osActual.tmpdir(), 'mh-node-service-'));
  fakePlatform = null;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// hasUserSystemd / runSystemctlUser
// ---------------------------------------------------------------------------

describe('hasUserSystemd', () => {
  it('returns true when `systemctl --user show-environment` exits 0', () => {
    spawnSyncMock.mockReturnValueOnce(ok('VAR=1\n'));
    expect(hasUserSystemd()).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'show-environment'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('returns false when the probe exits non-zero', () => {
    spawnSyncMock.mockReturnValueOnce(fail(1));
    expect(hasUserSystemd()).toBe(false);
  });

  it('returns false when spawnSync throws (e.g. systemctl not on PATH)', () => {
    spawnSyncMock.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(hasUserSystemd()).toBe(false);
  });
});

describe('runSystemctlUser', () => {
  it('captures stdout/stderr/status instead of inheriting the terminal', () => {
    spawnSyncMock.mockReturnValueOnce(ok('active (running)\n', ''));
    const res = runSystemctlUser(['status', SERVICE_UNIT, '--no-pager']);
    expect(res).toEqual({ status: 0, stdout: 'active (running)\n', stderr: '' });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'status', SERVICE_UNIT, '--no-pager'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('normalizes a thrown error into a null-status result rather than throwing', () => {
    spawnSyncMock.mockImplementationOnce(() => {
      throw new Error('spawn failure');
    });
    const res = runSystemctlUser(['daemon-reload']);
    expect(res.status).toBeNull();
    expect(res.stderr).toContain('spawn failure');
  });
});

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

describe('runInstall', () => {
  it('short-circuits on win32 without ever probing systemd', () => {
    fakePlatform = 'win32';
    const report = runInstall();
    expect(report.ok).toBe(false);
    expect(report.lines.some((l) => l.text.includes('Windows'))).toBe(true);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('reports "no user systemd" guidance when the probe fails', () => {
    spawnSyncMock.mockReturnValueOnce(fail(1)); // show-environment
    const report = runInstall();
    expect(report.ok).toBe(false);
    expect(report.lines.some((l) => l.text.includes('No per-user systemd instance'))).toBe(true);
  });

  it('writes the unit file and runs daemon-reload + enable --now on the happy path', () => {
    spawnSyncMock
      .mockReturnValueOnce(ok()) // show-environment (hasUserSystemd)
      .mockReturnValueOnce(ok('')) // daemon-reload
      .mockReturnValueOnce(ok('Created symlink ...\n')); // enable --now

    const report = runInstall();

    expect(report.ok).toBe(true);
    expect(report.lines.some((l) => l.text.includes('Wrote'))).toBe(true);
    expect(report.lines.some((l) => l.text.includes('Service enabled and started.'))).toBe(true);

    const unitPath = path.join(systemdUserDir(), SERVICE_UNIT);
    expect(fs.existsSync(unitPath)).toBe(true);
    expect(fs.readFileSync(unitPath, 'utf-8')).toBe(unitFileContent());

    // 3 systemctl calls total: probe, daemon-reload, enable --now.
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'daemon-reload'],
      expect.anything(),
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      3,
      'systemctl',
      ['--user', 'enable', '--now', SERVICE_UNIT],
      expect.anything(),
    );
  });

  it('stops after daemon-reload fails and never calls enable --now', () => {
    spawnSyncMock
      .mockReturnValueOnce(ok()) // show-environment
      .mockReturnValueOnce(fail(1, '', 'reload failed')); // daemon-reload

    const report = runInstall();
    expect(report.ok).toBe(false);
    expect(report.lines.some((l) => l.text.includes('reload failed'))).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// runUninstall
// ---------------------------------------------------------------------------

describe('runUninstall', () => {
  it('reports "no user systemd" guidance when the probe fails', () => {
    spawnSyncMock.mockReturnValueOnce(fail(1));
    const report = runUninstall();
    expect(report.ok).toBe(false);
    expect(report.lines.some((l) => l.text.includes('No per-user systemd instance'))).toBe(true);
  });

  it('removes an existing unit file and reports success', () => {
    const dir = systemdUserDir();
    fs.mkdirSync(dir, { recursive: true });
    const unitPath = path.join(dir, SERVICE_UNIT);
    fs.writeFileSync(unitPath, unitFileContent());

    spawnSyncMock
      .mockReturnValueOnce(ok()) // show-environment (hasUserSystemd)
      .mockReturnValueOnce(ok()) // disable --now
      .mockReturnValueOnce(ok()); // daemon-reload

    const report = runUninstall();
    expect(report.ok).toBe(true);
    expect(fs.existsSync(unitPath)).toBe(false);
    expect(report.lines.some((l) => l.text.includes('Removed'))).toBe(true);
    expect(report.lines.some((l) => l.text.includes('Service uninstalled.'))).toBe(true);
  });

  it('is best-effort about disable failing and about a missing unit file', () => {
    // No unit file was ever created in this fakeHome.
    spawnSyncMock
      .mockReturnValueOnce(ok()) // show-environment (hasUserSystemd)
      .mockReturnValueOnce(fail(5, '', 'Unit not loaded.')) // disable --now (best-effort)
      .mockReturnValueOnce(ok()); // daemon-reload still runs and succeeds

    const report = runUninstall();
    expect(report.ok).toBe(true);
    expect(report.lines.some((l) => l.text.includes('Unit file not present'))).toBe(true);
  });

  it('propagates a daemon-reload failure as ok:false', () => {
    spawnSyncMock
      .mockReturnValueOnce(ok()) // show-environment (hasUserSystemd)
      .mockReturnValueOnce(ok()) // disable --now
      .mockReturnValueOnce(fail(1, '', 'reload broke')); // daemon-reload

    const report = runUninstall();
    expect(report.ok).toBe(false);
    expect(report.lines.some((l) => l.text.includes('reload broke'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

describe('runStatus', () => {
  it('reports "no user systemd" guidance when the probe fails', () => {
    spawnSyncMock.mockReturnValueOnce(fail(1));
    const report = runStatus();
    expect(report.ok).toBe(false);
  });

  it('treats a non-zero exit (inactive unit) as a normal result, not a failure', () => {
    spawnSyncMock
      .mockReturnValueOnce(ok()) // show-environment probe
      .mockReturnValueOnce(fail(3, '○ memoriahub-node.service - MemoriaHub worker node\n   Active: inactive (dead)\n'));

    const report = runStatus();
    expect(report.ok).toBe(true); // status is never a hard failure (mirrors the CLI comment)
    expect(report.lines.some((l) => l.text.includes('inactive (dead)'))).toBe(true);
    expect(report.lines.some((l) => l.text.includes('exit 3'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Component: NodeService (Ink render + key handling)
// ---------------------------------------------------------------------------

describe('NodeService component', () => {
  it('renders the action menu on mount', () => {
    const { lastFrame, unmount } = render(<NodeService onBack={() => {}} />);
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Worker Node — Service');
    expect(plain).toContain('[i] install');
    expect(plain).toContain('[u] uninstall');
    expect(plain).toContain('[s] status');
    unmount();
  });

  it('calls onBack from the menu on q', () => {
    const onBack = jest.fn();
    const { stdin, unmount } = render(<NodeService onBack={onBack} />);
    stdin.write('q');
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('runs install via "i" and renders the captured output without touching the real terminal', async () => {
    spawnSyncMock
      .mockReturnValueOnce(ok()) // show-environment
      .mockReturnValueOnce(ok()) // daemon-reload
      .mockReturnValueOnce(ok('Created symlink ...\n')); // enable --now

    const { lastFrame, stdin, unmount } = render(<NodeService onBack={() => {}} />);
    stdin.write('i');
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Install');
    expect(plain).toContain('Service enabled and started.');
    unmount();
  });

  it('runs status via "s" and renders inactive-unit output as a non-error', async () => {
    spawnSyncMock
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(fail(3, 'Active: inactive (dead)\n'));

    const { lastFrame, stdin, unmount } = render(<NodeService onBack={() => {}} />);
    stdin.write('s');
    await flushAsync(100);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Active: inactive (dead)');
    unmount();
  });

  it('returns to the menu on "b" from the result screen', async () => {
    spawnSyncMock.mockReturnValueOnce(fail(1)); // no user systemd -> fast, deterministic result

    const { lastFrame, stdin, unmount } = render(<NodeService onBack={() => {}} />);
    stdin.write('u');
    await flushAsync(100);
    expect(stripAnsi(lastFrame()!)).toContain('Uninstall');

    stdin.write('b');
    await flushAsync();
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('[i] install');
    unmount();
  });
});
