/**
 * test/tui/home-menu.spec.tsx
 *
 * Tests for the HomeMenu TUI component.
 *
 * No DB, network, or filesystem access required — HomeMenu is a pure
 * presentational component driven by `config` and `identity` props.
 */

import { jest } from '@jest/globals';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { HomeMenu } from '../../src/tui/HomeMenu.js';
import type { MenuNode } from '../../src/tui/menu-config.js';

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

    it('shows only Login, Settings, Help, and Quit top-level menu items', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      // These four items must appear
      expect(plain).toContain('Login');
      expect(plain).toContain('Settings');
      expect(plain).toContain('Help');
      expect(plain).toContain('Quit');
    });

    it('does NOT show Sync, Reports, or Tools submenus when logged out', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).not.toContain('Sync ▸');
      expect(plain).not.toContain('Reports ▸');
      expect(plain).not.toContain('Tools ▸');
      // Sync/folders leaf actions (which only exist inside those hidden
      // submenus) must not leak through either.
      expect(plain).not.toContain('Sync all folders');
      expect(plain).not.toContain('Manage folders');
      expect(plain).not.toContain('Retry failed files');
    });

    it('DOES show the Settings submenu when logged out (it contains a loggedOut leaf)', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Settings ▸');
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

    it('shows the full top-level menu including Sync, Reports, Settings, and Tools submenus', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Sync ▸');
      expect(plain).toContain('Reports ▸');
      expect(plain).toContain('Settings ▸');
      expect(plain).toContain('Tools ▸');
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
  // onSelect(node) contract
  // -------------------------------------------------------------------------

  describe('onSelect(node)', () => {
    it('calls onSelect with the leaf action node for the pre-highlighted item (Login)', () => {
      const onSelect = jest.fn<(node: MenuNode) => void>();
      const { stdin } = render(
        <HomeMenu config={null} identity={null} onSelect={onSelect} />,
      );

      stdin.write('\r');

      expect(onSelect).toHaveBeenCalledTimes(1);
      const node = onSelect.mock.calls[0]![0];
      expect(node.kind).toBe('action');
      expect(node.label).toBe('Login / Change server');
    });

    it('calls onSelect with the submenu node (not an action) when navigating to Sync', async () => {
      const onSelect = jest.fn<(node: MenuNode) => void>();
      const { stdin } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={onSelect}
        />,
      );

      // Move down from Login to Sync, then select it.
      stdin.write('\x1B[B'); // down arrow
      await new Promise((r) => setTimeout(r, 50));
      stdin.write('\r');
      await new Promise((r) => setTimeout(r, 50));

      expect(onSelect).toHaveBeenCalledTimes(1);
      const node = onSelect.mock.calls[0]![0];
      expect(node.kind).toBe('submenu');
      expect(node.label).toBe('Sync');
    });
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
