/**
 * test/menu-config.spec.ts
 *
 * Pure unit tests for the hierarchical menu tree and its helpers
 * (visibleChildren, menuItemLabel, findSubmenu, breadcrumb). No Ink/React
 * involved — these are plain data + function tests.
 *
 * Covers the issue #413 restructure: the flattened root (Backup and Worker
 * Node promoted out of the old Tools grab-bag, Job queue monitor moved under
 * Reports, the offline utilities regrouped as File Tools), the CASCADING
 * `loggedOut` gate, and the single shared label-decoration helper.
 */

import {
  MENU_TREE,
  visibleChildren,
  menuItemLabel,
  findSubmenu,
  breadcrumb,
  type MenuNode,
} from '../src/tui/menu-config.js';
import { REPORTS } from '../src/reports/registry.js';

function labels(nodes: MenuNode[]): string[] {
  return nodes.map((n) => n.label);
}

function actions(nodes: MenuNode[]): (string | null)[] {
  return nodes.map((n) => (n.kind === 'action' ? n.action : null));
}

describe('menu-config', () => {
  // ---------------------------------------------------------------------------
  // visibleChildren — root shape
  // ---------------------------------------------------------------------------

  describe('visibleChildren', () => {
    it('returns the 9 restructured top-level nodes, in order, when logged in', () => {
      const nodes = visibleChildren(MENU_TREE, true);
      expect(labels(nodes)).toEqual([
        'Sync',
        'Scan',
        'Backup',
        'Worker Node',
        'Reports',
        'File Tools',
        'Settings',
        'Help',
        'Quit',
      ]);
    });

    it('no longer exposes a Tools submenu at any level', () => {
      expect(findSubmenu('tools')).toBeUndefined();
      expect(labels(visibleChildren(MENU_TREE, true))).not.toContain('Tools');
    });

    it('hides Login at the root once logged in (it moves into Settings)', () => {
      expect(labels(visibleChildren(MENU_TREE, true))).not.toContain('Login / Change server');
      expect(labels(visibleChildren(findSubmenu('settings')!, true))).toContain(
        'Login / Change server',
      );
    });

    it('returns exactly [Login, Scan, File Tools, Settings, Help, Quit] when logged out', () => {
      const nodes = visibleChildren(MENU_TREE, false);
      expect(labels(nodes)).toEqual([
        'Login / Change server',
        'Scan',
        'File Tools',
        'Settings',
        'Help',
        'Quit',
      ]);
    });

    it('hides the login-gated Sync / Backup / Worker Node / Reports entries when logged out', () => {
      const shown = labels(visibleChildren(MENU_TREE, false));
      expect(shown).not.toContain('Sync');
      expect(shown).not.toContain('Backup');
      expect(shown).not.toContain('Worker Node');
      expect(shown).not.toContain('Reports');
    });

    it('within Settings when logged out, only the factory-reset loggedOut leaf is visible', () => {
      const settings = findSubmenu('settings')!;
      expect(labels(visibleChildren(settings, false))).toEqual([
        'Factory reset (delete all local data)',
      ]);
    });

    it('within Settings when logged in, all settings leaves are visible', () => {
      const settings = findSubmenu('settings')!;
      expect(labels(visibleChildren(settings, true))).toEqual([
        'Manage folders',
        'Manage circles',
        'App settings',
        'Login / Change server',
        'Factory reset (delete all local data)',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // loggedOut cascade (issue #413 §2.1)
  // ---------------------------------------------------------------------------

  describe('loggedOut cascade', () => {
    it("makes a leaf under an offline submenu visible logged out WITHOUT its own flag", () => {
      const convert = findSubmenu('convert')!;
      // None of these leaves carries loggedOut — they inherit it from File Tools.
      expect(convert.children.every((c) => c.loggedOut === undefined)).toBe(true);
      expect(visibleChildren(convert, false, true)).toHaveLength(3);
    });

    it('cascades through File Tools to every nested descendant when logged out', () => {
      const fileTools = findSubmenu('file-tools')!;
      expect(labels(visibleChildren(fileTools, false))).toEqual([
        'Convert videos to MP4',
        'Organize folder by date',
        'Find/Clean Screenshots',
        'Date Inference',
      ]);
      for (const id of ['convert', 'screenshots', 'date-infer']) {
        const sub = findSubmenu(id)!;
        // Reached through File Tools, so the inherited flag applies.
        expect(visibleChildren(sub, false, true).length).toBe(sub.children.length);
      }
    });

    it('drops per-leaf loggedOut duplication under the offline submenus', () => {
      for (const id of ['convert', 'screenshots', 'date-infer']) {
        const sub = findSubmenu(id)!;
        expect(sub.loggedOut).toBeUndefined();
        expect(sub.children.some((c) => c.loggedOut !== undefined)).toBe(false);
      }
    });

    it('lets a child opt OUT of an inherited cascade with an explicit loggedOut: false', () => {
      const optOut = {
        kind: 'submenu' as const,
        id: 'test-parent',
        label: 'Parent',
        loggedOut: true,
        children: [
          { kind: 'action' as const, label: 'Inherits', action: 'help' as const },
          { kind: 'action' as const, label: 'Opts out', action: 'quit' as const, loggedOut: false },
        ],
      };
      expect(labels(visibleChildren(optOut, false))).toEqual(['Inherits']);
      expect(labels(visibleChildren(optOut, true))).toEqual(['Inherits', 'Opts out']);
    });

    it('defaults to login-required when no ancestor sets loggedOut', () => {
      const sync = findSubmenu('sync')!;
      expect(visibleChildren(sync, false)).toHaveLength(0);
      expect(visibleChildren(sync, true)).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // menuItemLabel (issue #413 §2.3 + §2.5 + §2.7)
  // ---------------------------------------------------------------------------

  describe('menuItemLabel', () => {
    const submenu = findSubmenu('sync')!;
    const syncAll = submenu.children[0]!;   // ellipsis: true
    const retry = submenu.children[2]!;     // immediate

    it('appends the chevron to a submenu label', () => {
      expect(menuItemLabel(submenu)).toBe('Sync ▸');
    });

    it('appends an ellipsis to a leaf that opens a further input step', () => {
      expect(menuItemLabel(syncAll)).toBe('Sync all folders…');
    });

    it('leaves an immediate action bare', () => {
      expect(menuItemLabel(retry)).toBe('Retry failed files');
    });

    it('prefixes a 1-based position of 1–9 with a digit accelerator', () => {
      expect(menuItemLabel(retry, 1)).toBe('1. Retry failed files');
      expect(menuItemLabel(submenu, 9)).toBe('9. Sync ▸');
    });

    it('pads positions past 9 so the label column stays aligned', () => {
      expect(menuItemLabel(retry, 10)).toBe('   Retry failed files');
    });

    it('omits the prefix entirely when no position is given', () => {
      expect(menuItemLabel(retry)).toBe('Retry failed files');
    });
  });

  // ---------------------------------------------------------------------------
  // Ellipsis + colour conventions across the tree
  // ---------------------------------------------------------------------------

  describe('label conventions', () => {
    it('marks every folder-picker / prompt action with an ellipsis', () => {
      const expected = [
        'sync-all',
        'sync-select',
        'scan-select',
        'organize',
        'screenshots-find',
        'screenshots-move',
        'screenshots-delete',
        'date-infer-diagnose',
        'date-infer-apply',
        'convert-file',
        'convert-select',
      ];
      const withEllipsis: string[] = [];
      const walk = (n: typeof MENU_TREE): void => {
        for (const c of n.children) {
          if (c.kind === 'submenu') walk(c);
          else if (c.ellipsis) withEllipsis.push(c.action);
        }
      };
      walk(MENU_TREE);
      expect(withEllipsis.sort()).toEqual(expected.sort());
    });

    it('leaves immediate actions and dashboards without an ellipsis', () => {
      const immediate = ['retry', 'scan-all', 'scan-report', 'convert-all', 'backup-dashboard'];
      const walk = (n: typeof MENU_TREE): MenuNode[] =>
        n.children.flatMap((c) => (c.kind === 'submenu' ? walk(c) : [c]));
      for (const node of walk(MENU_TREE)) {
        if (node.kind === 'action' && immediate.includes(node.action)) {
          expect(node.ellipsis).toBeUndefined();
        }
      }
    });

    it('renders the two destructive entries in red', () => {
      const red: string[] = [];
      const walk = (n: typeof MENU_TREE): void => {
        for (const c of n.children) {
          if (c.kind === 'submenu') walk(c);
          else if (c.color === 'red') red.push(c.action);
        }
      };
      walk(MENU_TREE);
      expect(red.sort()).toEqual(['factory-reset', 'screenshots-delete']);
    });
  });

  // ---------------------------------------------------------------------------
  // Restructured branches
  // ---------------------------------------------------------------------------

  describe('Backup', () => {
    it('is a single root leaf opening the dashboard, not a submenu', () => {
      const backup = visibleChildren(MENU_TREE, true).find((n) => n.label === 'Backup')!;
      expect(backup.kind).toBe('action');
      expect(backup.kind === 'action' && backup.action).toBe('backup-dashboard');
      expect(findSubmenu('backup')).toBeUndefined();
    });
  });

  describe('Reports', () => {
    it('lists the report registry followed by the job queue monitor', () => {
      const reports = findSubmenu('reports')!;
      expect(actions(reports.children)).toEqual([
        ...REPORTS.map((r) => `report:${r.id}`),
        'jobs',
      ]);
      expect(labels(reports.children)).toEqual([...REPORTS.map((r) => r.label), 'Job queue monitor']);
    });
  });

  describe('Worker Node', () => {
    it('orders daily operations first and first-run setup last', () => {
      const node = findSubmenu('node')!;
      expect(labels(node.children)).toEqual([
        'Node dashboard',
        'Start worker (background)',
        'Stop worker',
        'Node logs',
        'Node doctor',
        'Enroll node (login + credential)',
        'Install dependencies (Linux)',
        'Register node',
        'Node config',
        'List nodes',
        'Node service (systemd)',
      ]);
    });

    it('exposes the three new onboarding/lifecycle actions', () => {
      const node = findSubmenu('node')!;
      expect(actions(node.children)).toEqual(
        expect.arrayContaining(['node-enroll', 'node-install-deps', 'node-stop']),
      );
    });

    it('stays hidden when logged out (root Login is the logged-out entry point)', () => {
      expect(visibleChildren(findSubmenu('node')!, false)).toHaveLength(0);
    });
  });

  describe('Scan', () => {
    it('drops the parenthetical from the label and carries it as a subtitle', () => {
      const scan = findSubmenu('scan')!;
      expect(scan.label).toBe('Scan');
      expect(scan.subtitle).toContain('Dry-run preview');
    });
  });

  // ---------------------------------------------------------------------------
  // findSubmenu
  // ---------------------------------------------------------------------------

  describe('findSubmenu', () => {
    it('returns undefined for an unknown id', () => {
      expect(findSubmenu('does-not-exist')).toBeUndefined();
    });

    it('finds the root submenu by id', () => {
      expect(findSubmenu('root')!.label).toBe('Menu');
    });

    it('finds the sync submenu with its 3 action children', () => {
      const sync = findSubmenu('sync')!;
      expect(sync.children.every((c) => c.kind === 'action')).toBe(true);
      expect(labels(sync.children)).toEqual([
        'Sync all folders',
        'Sync selected folders',
        'Retry failed files',
      ]);
    });

    it('finds the scan submenu with its 3 action children', () => {
      const scan = findSubmenu('scan')!;
      expect(actions(scan.children)).toEqual(['scan-all', 'scan-select', 'scan-report']);
      expect(visibleChildren(scan, false)).toHaveLength(3);
    });

    it('finds the convert submenu nested under File Tools', () => {
      const convert = findSubmenu('convert')!;
      expect(actions(convert.children)).toEqual(['convert-file', 'convert-select', 'convert-all']);
    });
  });

  // ---------------------------------------------------------------------------
  // breadcrumb
  // ---------------------------------------------------------------------------

  describe('breadcrumb', () => {
    it("returns 'Menu' for the root id", () => {
      expect(breadcrumb('root')).toBe('Menu');
    });

    it('returns the one-level path for a root submenu', () => {
      expect(breadcrumb('sync')).toBe('Menu › Sync');
      expect(breadcrumb('reports')).toBe('Menu › Reports');
      expect(breadcrumb('settings')).toBe('Menu › Settings');
      expect(breadcrumb('node')).toBe('Menu › Worker Node');
      expect(breadcrumb('file-tools')).toBe('Menu › File Tools');
    });

    it('returns the nested path under File Tools for convert', () => {
      expect(breadcrumb('convert')).toBe('Menu › File Tools › Convert videos to MP4');
    });

    it('falls back to the root label for an unknown id', () => {
      expect(breadcrumb('nonexistent')).toBe('Menu');
    });
  });
});
