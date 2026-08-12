/**
 * test/tui/node-install-deps.spec.tsx
 *
 * Coverage for the Install dependencies screen added by issue #413.
 *
 * The screen deliberately SHELLS OUT to this same CLI rather than calling
 * node/install-deps.ts in-process (that module writes progress to stdout with
 * ui.*, which Ink owns), so the two things worth pinning down are the argv it
 * builds — a dry run must never be able to become a real run by accident — and
 * that the menu never spawns anything until the user picks a mode.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

import { NodeInstallDeps, installDepsArgv } from '../../src/tui/NodeInstallDeps.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

afterEach(() => {
  cleanup();
});

describe('installDepsArgv', () => {
  it('re-invokes this same CLI entry point through its own node binary', () => {
    const { cmd, args } = installDepsArgv('install');
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['node', 'install-deps']);
  });

  it('adds --dry-run for the plan mode and only for the plan mode', () => {
    expect(installDepsArgv('plan').args).toContain('--dry-run');
    expect(installDepsArgv('install').args).not.toContain('--dry-run');
  });
});

describe('NodeInstallDeps screen', () => {
  it('opens on the mode menu, spawning nothing', () => {
    const { lastFrame } = render(<NodeInstallDeps onBack={() => {}} />);
    const plain = stripAnsi(lastFrame()!);

    expect(plain).toContain('Worker Node — Install dependencies');
    expect(plain).toContain('[p] plan (dry run — changes nothing)');
    expect(plain).not.toContain('running…');
  });

  it('Esc backs out from the menu', async () => {
    const onBack = jest.fn();
    const { stdin } = render(<NodeInstallDeps onBack={onBack} />);

    stdin.write('\x1B');
    await new Promise((r) => setTimeout(r, 50));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('offers the real install only on Linux, and warns everywhere else', () => {
    const { lastFrame } = render(<NodeInstallDeps onBack={() => {}} />);
    const plain = stripAnsi(lastFrame()!);

    if (process.platform === 'linux') {
      expect(plain).toContain('[i] install');
    } else {
      expect(plain).not.toContain('[i] install');
      expect(plain).toContain('supports Linux only');
    }
  });
});
