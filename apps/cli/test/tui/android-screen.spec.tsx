/**
 * test/tui/android-screen.spec.tsx — the Android screen renders its status and
 * actions, and builds child argv that re-invokes this same CLI (issue #517).
 */

import React from 'react';
import { cleanup, render } from 'ink-testing-library';

import { AndroidScreen, androidArgv } from '../../src/tui/AndroidScreen.js';

afterEach(() => cleanup());

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('androidArgv', () => {
  it('re-invokes this CLI entry through its own node binary, under `android`', () => {
    const { cmd, args } = androidArgv(['--repo', '/r', 'build']);
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['android', '--repo', '/r', 'build']);
  });
});

describe('AndroidScreen', () => {
  it('opens on the status panel and the action list, spawning nothing', async () => {
    const { lastFrame } = render(<AndroidScreen onBack={() => {}} onLogin={() => {}} />);
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('Android app (build, publish, releases)');
    expect(plain).toContain('Doctor');
    expect(plain).toContain('Release  (pre-check');
    expect(plain).not.toContain('running…');
  });
});
