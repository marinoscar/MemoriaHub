/**
 * test/tui/backup-menu-nav.spec.tsx
 *
 * Navigation coverage for the Tools ▸ Backup submenu (issue #320), which
 * replaced the single "Backup" placeholder leaf with four entries.
 *
 * Same harness rationale as test/tui/menu-nav.spec.tsx: app.tsx's `App` is not
 * exported and rendering it end-to-end would require stubbing config/db/network
 * plumbing, so we drive the SAME production pieces (the generic <Menu> + the
 * menu-config helpers) through a minimal local nav harness mirroring app.tsx's
 * push/pop stack.
 *
 * The dispatcher test at the bottom closes the gap that a render test alone
 * cannot: a menu entry wired into the tree but forgotten in app.tsx's
 * openAction switch would render fine and do nothing when selected.
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
  visibleChildren,
  type MenuActionId,
  type MenuNode,
} from '../../src/tui/menu-config.js';
import { waitForFrame } from './wait-for.js';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

const BACKUP_ACTIONS: MenuActionId[] = [
  'backup-dashboard',
  'backup-run',
  'backup-verify',
  'backup-settings',
];

// ---------------------------------------------------------------------------
// Nav harness — mirrors app.tsx's stack/push/pop/toItem/selectChild
// ---------------------------------------------------------------------------

function NavHarness({
  startMenuId = 'backup',
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

  function toItem(node: MenuNode): { label: string; value: string } {
    if (node.kind === 'submenu') return { label: `${node.label} ▸`, value: `submenu:${node.id}` };
    return { label: node.label, value: `action:${node.action}` };
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
      subtitle="Use arrow keys and Enter to navigate"
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

describe('Tools ▸ Backup submenu', () => {
  it('is a submenu under Tools, not a leaf', () => {
    const tools = findSubmenu('tools')!;
    const backup = tools.children.find((c) => c.label === 'Backup');
    expect(backup).toBeDefined();
    expect(backup!.kind).toBe('submenu');
  });

  it('exposes exactly the four backup screens in order', () => {
    const backup = findSubmenu('backup')!;
    expect(backup.children.map((c) => c.label)).toEqual([
      'Backup dashboard',
      'Run backup now',
      'Verify backup',
      'Backup settings',
    ]);
    expect(backup.children.map((c) => (c.kind === 'action' ? c.action : null))).toEqual(
      BACKUP_ACTIONS,
    );
  });

  it('requires login (no backup entry is visible logged out)', () => {
    const tools = findSubmenu('tools')!;
    const loggedOut = visibleChildren(tools, false).map((c) => c.label);
    expect(loggedOut).not.toContain('Backup');
    expect(visibleChildren(tools, true).map((c) => c.label)).toContain('Backup');
  });

  it('breadcrumbs as Menu › Tools › Backup', () => {
    expect(breadcrumb('backup')).toBe('Menu › Tools › Backup');
  });

  it('leaves the rest of the Tools menu order untouched', () => {
    const tools = findSubmenu('tools')!;
    expect(visibleChildren(tools, true).map((c) => c.label)).toEqual([
      'Convert videos to MP4',
      'Organize folder by date',
      'Find/Clean Screenshots',
      'Date Inference',
      'Job queue monitor',
      'Backup',
      'Worker Node',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rendering + selection
// ---------------------------------------------------------------------------

describe('backup submenu navigation', () => {
  it('renders all four entries under the Backup breadcrumb', async () => {
    const { lastFrame } = render(<NavHarness />);
    const plain = await waitForFrame(lastFrame, (f) =>
      stripAnsi(f).includes('Backup dashboard'),
    ).then(stripAnsi);

    expect(plain).toContain('Menu › Tools › Backup');
    expect(plain).toContain('Backup dashboard');
    expect(plain).toContain('Run backup now');
    expect(plain).toContain('Verify backup');
    expect(plain).toContain('Backup settings');
  });

  it('selecting the first entry dispatches backup-dashboard', async () => {
    const actions: MenuActionId[] = [];
    const { lastFrame, stdin } = render(<NavHarness onAction={(a) => actions.push(a)} />);
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Backup dashboard'));

    stdin.write('\r'); // Enter on the first (already-highlighted) item
    await waitForFrame(lastFrame, () => actions.length > 0);
    expect(actions).toEqual(['backup-dashboard']);
  });

  it('arrowing down and selecting dispatches the NEXT entry', async () => {
    const actions: MenuActionId[] = [];
    const { lastFrame, stdin } = render(<NavHarness onAction={(a) => actions.push(a)} />);
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Run backup now'));

    // Diff the target row against its unselected baseline rather than matching
    // a pointer glyph — ink-select-input's indicator varies by environment.
    const baseline = (lastFrame() ?? '').split('\n').find((l) => l.includes('Run backup now'));
    stdin.write('\x1B[B');
    await waitForFrame(lastFrame, (f) => {
      const line = f.split('\n').find((l) => l.includes('Run backup now'));
      return !!line && line !== baseline;
    });

    stdin.write('\r');
    await waitForFrame(lastFrame, () => actions.length > 0);
    expect(actions).toEqual(['backup-run']);
  });

  it('Esc from the Backup submenu pops back to Tools', async () => {
    const { lastFrame, stdin } = render(<NavHarness startMenuId="tools" />);
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Backup ▸'));

    // Tools order: Convert, Organize, Screenshots, Date Inference, Jobs, Backup.
    // Each arrow is awaited individually — ink-select-input tracks its selected
    // index internally, so writing five arrows back to back races that state and
    // only some of them land.
    for (let i = 0; i < 5; i++) {
      const before = lastFrame() ?? '';
      stdin.write('\x1B[B');
      // eslint-disable-next-line no-await-in-loop
      await waitForFrame(lastFrame, (f) => f !== before);
    }

    stdin.write('\r');
    await waitForFrame(lastFrame, (f) => stripAnsi(f).includes('Menu › Tools › Backup'));

    stdin.write('\x1B'); // Esc
    const plain = await waitForFrame(lastFrame, (f) => {
      const p = stripAnsi(f);
      return p.includes('Menu › Tools') && !p.includes('Backup dashboard');
    }).then(stripAnsi);

    expect(plain).toContain('Job queue monitor');
    expect(plain).not.toContain('Backup dashboard');
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

  it.each(BACKUP_ACTIONS)('handles the %s action and pushes a screen', (action) => {
    expect(appSource).toContain(`case '${action}':`);
  });

  it.each(['backupDashboard', 'backupVerify', 'backupSettings'])(
    'renders the %s screen',
    (screenKind) => {
      expect(appSource).toContain(`case '${screenKind}':`);
    },
  );

  it('no longer references the removed placeholder BackupScreen', () => {
    expect(appSource).not.toContain('BackupScreen');
    expect(fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/tui/BackupScreen.tsx'))).toBe(false);
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
});
