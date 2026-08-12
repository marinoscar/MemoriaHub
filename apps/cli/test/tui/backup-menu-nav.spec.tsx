/**
 * test/tui/backup-menu-nav.spec.tsx
 *
 * Navigation coverage for the two branches the issue #413 restructure moved
 * out of the old `Tools` grab-bag and onto the root menu: Backup (collapsed
 * from a four-entry submenu to a single leaf opening the dashboard) and Worker
 * Node (promoted, reordered, and given its three missing onboarding entries).
 *
 * Same harness rationale as test/tui/menu-nav.spec.tsx: app.tsx's `App` is not
 * exported and rendering it end-to-end would require stubbing config/db/network
 * plumbing, so we drive the SAME production pieces (the generic <Menu> + the
 * menu-config helpers) through a minimal local nav harness mirroring app.tsx's
 * push/pop stack.
 *
 * The dispatcher tests at the bottom close the gap that a render test alone
 * cannot: a menu entry wired into the tree but forgotten in app.tsx's
 * openAction switch would render fine and do nothing when selected. Collapsing
 * the Backup submenu makes the reverse check matter too — `backup-run` /
 * `backup-verify` / `backup-settings` no longer appear in the tree, but their
 * screens are still reached from inside BackupDashboard, so they must stay
 * wired.
 */

import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { useState } from 'react';
import { render, cleanup } from 'ink-testing-library';

import { Menu } from '../../src/tui/Menu.js';
import {
  MENU_TREE,
  breadcrumb,
  findSubmenu,
  menuItemLabel,
  visibleChildren,
  type MenuActionId,
  type MenuNode,
} from '../../src/tui/menu-config.js';
import { waitForFrame } from './wait-for.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Backup screens still reachable from within BackupDashboard after the collapse. */
const IN_DASHBOARD_BACKUP_ACTIONS: MenuActionId[] = [
  'backup-run',
  'backup-verify',
  'backup-settings',
];

/** The three Worker Node entries added by #413. */
const NEW_NODE_ACTIONS: MenuActionId[] = ['node-stop', 'node-enroll', 'node-install-deps'];

// ---------------------------------------------------------------------------
// Nav harness — mirrors app.tsx's stack/push/pop/toItem/selectChild
// ---------------------------------------------------------------------------

function NavHarness({
  startMenuId = 'node',
  onAction,
}: {
  startMenuId?: string;
  onAction?: (action: MenuActionId) => void;
}): React.ReactElement {
  const [stack, setStack] = useState<string[]>([startMenuId]);

  function pop(): void {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }

  function handleSelect(node: MenuNode): void {
    if (node.kind === 'submenu') setStack((prev) => [...prev, node.id]);
    else onAction?.(node.action);
  }

  function toItem(node: MenuNode, index: number): { label: string; value: string; color?: string } {
    const label = menuItemLabel(node, index + 1);
    const value = node.kind === 'submenu' ? `submenu:${node.id}` : `action:${node.action}`;
    return node.color ? { label, value, color: node.color } : { label, value };
  }

  function selectChild(menuId: string, value: string): void {
    const submenu = findSubmenu(menuId);
    if (!submenu) return;
    const sep = value.indexOf(':');
    const kind = value.slice(0, sep);
    const rest = value.slice(sep + 1);
    const node = visibleChildren(submenu, true).find((c) =>
      c.kind === 'submenu'
        ? kind === 'submenu' && c.id === rest
        : kind === 'action' && c.action === rest,
    );
    if (node) handleSelect(node);
  }

  const top = stack[stack.length - 1]!;
  const submenu = findSubmenu(top);
  const items = submenu ? visibleChildren(submenu, true).map(toItem) : [];
  return (
    <Menu
      title={breadcrumb(top)}
      subtitle={submenu?.subtitle}
      items={items}
      onSelect={(value) => selectChild(top, value)}
      onBack={pop}
    />
  );
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tree shape
// ---------------------------------------------------------------------------

describe('Backup, collapsed to a root leaf', () => {
  it('is a root-level action opening the dashboard, with no Backup submenu left', () => {
    const backup = MENU_TREE.children.find((c) => c.label === 'Backup');
    expect(backup).toBeDefined();
    expect(backup!.kind).toBe('action');
    expect(backup!.kind === 'action' && backup!.action).toBe('backup-dashboard');
    expect(findSubmenu('backup')).toBeUndefined();
  });

  it('requires login', () => {
    expect(visibleChildren(MENU_TREE, false).map((c) => c.label)).not.toContain('Backup');
    expect(visibleChildren(MENU_TREE, true).map((c) => c.label)).toContain('Backup');
  });

  it('acts immediately, so it carries no ellipsis', () => {
    const backup = MENU_TREE.children.find((c) => c.label === 'Backup')!;
    expect(menuItemLabel(backup)).toBe('Backup');
  });
});

describe('Worker Node, promoted to the root menu', () => {
  it('is a root-level submenu, no longer nested under Tools', () => {
    expect(MENU_TREE.children.some((c) => c.kind === 'submenu' && c.id === 'node')).toBe(true);
    expect(breadcrumb('node')).toBe('Menu › Worker Node');
  });

  it('lists the eleven entries operations-first', () => {
    const node = findSubmenu('node')!;
    expect(node.children.map((c) => (c.kind === 'action' ? c.action : null))).toEqual([
      'node-dashboard',
      'node-start',
      'node-stop',
      'node-logs',
      'node-doctor',
      'node-enroll',
      'node-install-deps',
      'node-register',
      'node-config',
      'node-list',
      'node-service',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rendering + selection
// ---------------------------------------------------------------------------

describe('Worker Node submenu navigation', () => {
  it('renders the daily-operations entries first under the Worker Node breadcrumb', async () => {
    const { lastFrame } = render(<NavHarness />);
    const plain = await waitForFrame(lastFrame, (f) =>
      stripAnsi(f).includes('Node dashboard'),
    ).then(stripAnsi);

    expect(plain).toContain('Menu › Worker Node');
    expect(plain).toContain('1. Node dashboard');
    expect(plain).toContain('2. Start worker (background)');
    expect(plain).toContain('3. Stop worker');
    expect(plain).toContain('6. Enroll node (login + credential)');
    expect(plain).toContain('7. Install dependencies (Linux)');
  });

  it('selecting the first entry dispatches node-dashboard', async () => {
    const actions: MenuActionId[] = [];
    const { lastFrame, stdin } = render(<NavHarness onAction={(a) => actions.push(a)} />);
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Node dashboard'));

    stdin.write('\r'); // Enter on the first (already-highlighted) item
    await waitForFrame(lastFrame, () => actions.length > 0);
    expect(actions).toEqual(['node-dashboard']);
  });

  it('a digit accelerator dispatches that entry directly', async () => {
    const actions: MenuActionId[] = [];
    const { lastFrame, stdin } = render(<NavHarness onAction={(a) => actions.push(a)} />);
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Stop worker'));

    stdin.write('3'); // 3. Stop worker
    await waitForFrame(lastFrame, () => actions.length > 0);
    expect(actions).toEqual(['node-stop']);
  });

  it('Esc from the Worker Node submenu pops back to the parent frame', async () => {
    const { lastFrame, stdin } = render(<NavHarness startMenuId="root" />);
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Worker Node ▸'));

    stdin.write('4'); // 4. Worker Node
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Menu › Worker Node'));

    stdin.write('\x1B'); // Esc
    const plain = await waitForFrame(lastFrame, (f) => {
      const p = stripAnsi(f);
      return p.includes('Worker Node ▸') && !p.includes('Node dashboard');
    }).then(stripAnsi);

    expect(plain).toContain('Backup');
    expect(plain).not.toContain('Node dashboard');
  });
});

describe('File Tools submenu', () => {
  it('renders the offline utilities, including the red delete entry with its ellipsis', async () => {
    const { lastFrame, stdin } = render(<NavHarness startMenuId="file-tools" />);
    const plain = await waitForFrame(lastFrame, (f) =>
      stripAnsi(f).includes('Find/Clean Screenshots'),
    ).then(stripAnsi);

    expect(plain).toContain('Menu › File Tools');
    expect(plain).toContain('Organize folder by date…');

    stdin.write('3'); // 3. Find/Clean Screenshots
    const nested = await waitForFrame(lastFrame, (f) =>
      stripAnsi(f).includes('Find & delete screenshots'),
    ).then(stripAnsi);
    // The scary entry reads as the folder picker it actually opens.
    expect(nested).toContain('Find & delete screenshots…');
  });
});

// ---------------------------------------------------------------------------
// Dispatcher parity — every menu action must be handled in app.tsx
// ---------------------------------------------------------------------------

describe('app.tsx dispatcher', () => {
  const appSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/tui/app.tsx'),
    'utf8',
  );

  it.each(NEW_NODE_ACTIONS)('handles the %s action and pushes a screen', (action) => {
    expect(appSource).toContain(`case '${action}':`);
  });

  it.each(['nodeEnroll', 'nodeInstallDeps', 'nodeStop'])('renders the %s screen', (screenKind) => {
    expect(appSource).toContain(`case '${screenKind}':`);
  });

  it.each(IN_DASHBOARD_BACKUP_ACTIONS)(
    'keeps %s wired even though it left the menu tree (BackupDashboard still navigates to it)',
    (action) => {
      expect(appSource).toContain(`case '${action}':`);
    },
  );

  it('still renders the backup verify/settings screens the dashboard opens', () => {
    for (const screenKind of ['backupDashboard', 'backupVerify', 'backupSettings']) {
      expect(appSource).toContain(`case '${screenKind}':`);
    }
    expect(appSource).toContain('onOpenVerify');
    expect(appSource).toContain('onOpenSettings');
  });

  it('every action id in the tree is reachable from the dispatcher', () => {
    const walk = (node: typeof MENU_TREE): MenuActionId[] =>
      node.children.flatMap((c) =>
        c.kind === 'submenu' ? walk(c) : ([c.action] as MenuActionId[]),
      );
    for (const action of walk(MENU_TREE)) {
      if (action.startsWith('report:')) continue; // handled by a prefix branch
      expect(appSource).toContain(`case '${action}':`);
    }
  });

  it('replaces the ~10 copied login guards with one pre-switch check', () => {
    // The old inline block appeared once per login-required screen.
    expect(appSource).not.toContain('<Text dimColor>Press q to go back.</Text>');
    expect(appSource).toContain('LOGIN_REQUIRED_SCREENS');
    expect(appSource.match(/Not logged in\. Please login first\./g) ?? []).toHaveLength(1);
  });
});
