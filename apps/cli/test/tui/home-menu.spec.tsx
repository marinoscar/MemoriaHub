/**
 * test/tui/home-menu.spec.tsx
 *
 * Tests for the HomeMenu TUI component.
 *
 * No DB, network, or filesystem access required — HomeMenu is a pure
 * presentational component driven by `config` and `identity` props.
 */

import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { HomeMenu } from '../../src/tui/HomeMenu.js';

// Strip ANSI escape codes.
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

const FAKE_CONFIG = { serverUrl: 'http://test.local', pat: 'tok-test' };

afterEach(() => {
  cleanup();
});

describe('HomeMenu', () => {
  // -------------------------------------------------------------------------
  // Logged-out state
  // -------------------------------------------------------------------------

  describe('when not logged in (config=null, identity=null)', () => {
    it('renders without crashing', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      expect(lastFrame()).toBeTruthy();
    });

    it('shows the "Not logged in" message', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Not logged in');
    });

    it('shows only Login, Help, and Quit menu items', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      // These three items must appear
      expect(plain).toContain('Login');
      expect(plain).toContain('Help');
      expect(plain).toContain('Quit');
    });

    it('does NOT show sync/folders/status/retry/settings items when logged out', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).not.toContain('Sync all folders');
      expect(plain).not.toContain('Manage folders');
      expect(plain).not.toContain('Status');
      expect(plain).not.toContain('Retry failed files');
      expect(plain).not.toContain('Settings');
    });
  });

  // -------------------------------------------------------------------------
  // Logged-in state
  // -------------------------------------------------------------------------

  describe('when logged in (config set, identity set)', () => {
    it('renders without crashing', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      expect(lastFrame()).toBeTruthy();
    });

    it('shows the server URL in the identity box', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('http://test.local');
    });

    it('shows the user email in the identity box', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('alice@example.com');
    });

    it('shows full menu including sync and folders items', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Sync all folders');
      expect(plain).toContain('Manage folders');
      expect(plain).toContain('Status');
      expect(plain).toContain('Retry failed files');
      expect(plain).toContain('Settings');
    });

    it('still shows Login, Help, and Quit when logged in', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Login');
      expect(plain).toContain('Help');
      expect(plain).toContain('Quit');
    });
  });

  // -------------------------------------------------------------------------
  // Banner
  // -------------------------------------------------------------------------

  it('renders the MemoriaHub banner text', () => {
    const { lastFrame } = render(
      <HomeMenu config={null} identity={null} onSelect={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    // The banner contains "MemoriaHub" in its ASCII art letters
    expect(plain).toContain('MemoriaHub');
  });

  it('renders the DB path in the identity box', () => {
    const { lastFrame } = render(
      <HomeMenu config={null} identity={null} onSelect={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    // DB path should be present (from dbPath())
    expect(plain).toContain('DB:');
  });

  // -------------------------------------------------------------------------
  // Menu section header
  // -------------------------------------------------------------------------

  it('shows "Menu" section header', () => {
    const { lastFrame } = render(
      <HomeMenu config={null} identity={null} onSelect={() => {}} />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Menu');
  });
});
