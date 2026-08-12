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

    it('shows only Login, Scan, File Tools, Settings, Help, and Quit top-level menu items', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Login');
      expect(plain).toContain('Scan ▸');
      expect(plain).toContain('File Tools ▸');
      expect(plain).toContain('Settings ▸');
      expect(plain).toContain('Help');
      expect(plain).toContain('Quit');
      // Login-gated branches stay hidden.
      expect(plain).not.toContain('Backup');
      expect(plain).not.toContain('Worker Node');
    });

    it('does NOT show Sync or Reports submenus when logged out', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).not.toContain('Sync ▸');
      expect(plain).not.toContain('Reports ▸');
      // Sync/folders leaf actions (which only exist inside those hidden
      // submenus) must not leak through either.
      expect(plain).not.toContain('Sync all folders');
      expect(plain).not.toContain('Manage folders');
      expect(plain).not.toContain('Retry failed files');
    });

    it('DOES show the File Tools submenu when logged out (it hosts the offline convert/organize tools)', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} onSelect={() => {}} />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('File Tools ▸');
      // The old grab-bag submenu is gone.
      expect(plain).not.toContain('Tools ▸\n');
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

    it('shows the restructured root: Sync, Scan, Backup, Worker Node, Reports, File Tools, Settings', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Sync ▸');
      expect(plain).toContain('Scan ▸');
      expect(plain).toContain('Backup');
      expect(plain).toContain('Worker Node ▸');
      expect(plain).toContain('Reports ▸');
      expect(plain).toContain('File Tools ▸');
      expect(plain).toContain('Settings ▸');
    });

    it('numbers the root items 1–9 as digit accelerators, in the documented order', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      const plain = stripAnsi(lastFrame()!);
      for (const [i, label] of [
        'Sync ▸',
        'Scan ▸',
        'Backup',
        'Worker Node ▸',
        'Reports ▸',
        'File Tools ▸',
        'Settings ▸',
        'Help',
        'Quit',
      ].entries()) {
        expect(plain).toContain(`${i + 1}. ${label}`);
      }
    });

    it('drops the root Login entry once logged in (it moves into Settings)', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={() => {}}
        />,
      );
      const plain = stripAnsi(lastFrame()!);
      expect(plain).not.toContain('Login / Change server');
      expect(plain).toContain('Help');
      expect(plain).toContain('Quit');
    });

    it('shows the no-folders first-run hint when folderCount is 0', () => {
      const { lastFrame } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          folderCount={0}
          onSelect={() => {}}
        />,
      );
      expect(stripAnsi(lastFrame()!)).toContain(
        'No folders registered — start with Settings › Manage folders',
      );
    });

    it('hides the hint once folders exist, and while the count is still unknown', () => {
      const withFolders = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          folderCount={3}
          onSelect={() => {}}
        />,
      );
      expect(stripAnsi(withFolders.lastFrame()!)).not.toContain('No folders registered');
      cleanup();

      const unknown = render(
        <HomeMenu config={FAKE_CONFIG} identity="alice@example.com" onSelect={() => {}} />,
      );
      expect(stripAnsi(unknown.lastFrame()!)).not.toContain('No folders registered');
    });

    it('never shows the hint when logged out, even with zero folders', () => {
      const { lastFrame } = render(
        <HomeMenu config={null} identity={null} folderCount={0} onSelect={() => {}} />,
      );
      expect(stripAnsi(lastFrame()!)).not.toContain('No folders registered');
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

    it('calls onSelect with the submenu node (not an action) for the first logged-in item, Sync', async () => {
      const onSelect = jest.fn<(node: MenuNode) => void>();
      const { stdin } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={onSelect}
        />,
      );

      stdin.write('\r');
      await new Promise((r) => setTimeout(r, 50));

      expect(onSelect).toHaveBeenCalledTimes(1);
      const node = onSelect.mock.calls[0]![0];
      expect(node.kind).toBe('submenu');
      expect(node.label).toBe('Sync');
    });

    it('selects an item directly by its digit accelerator', async () => {
      const onSelect = jest.fn<(node: MenuNode) => void>();
      const { stdin } = render(
        <HomeMenu
          config={FAKE_CONFIG}
          identity="alice@example.com"
          onSelect={onSelect}
        />,
      );

      stdin.write('4'); // Worker Node — four rows below the highlight
      await new Promise((r) => setTimeout(r, 50));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect.mock.calls[0]![0].label).toBe('Worker Node');
    });

    it('ignores a digit past the end of the list', async () => {
      const onSelect = jest.fn<(node: MenuNode) => void>();
      const { stdin } = render(
        <HomeMenu config={null} identity={null} onSelect={onSelect} />,
      );

      stdin.write('9'); // logged out there are only 6 items
      await new Promise((r) => setTimeout(r, 50));

      expect(onSelect).not.toHaveBeenCalled();
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
