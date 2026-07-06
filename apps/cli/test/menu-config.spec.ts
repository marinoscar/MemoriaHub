/**
 * test/menu-config.spec.ts
 *
 * Pure unit tests for the hierarchical menu tree and its navigation helpers
 * (visibleChildren, findSubmenu, breadcrumb). No Ink/React involved — these
 * are plain data + function tests.
 */

import {
  MENU_TREE,
  visibleChildren,
  findSubmenu,
  breadcrumb,
  type MenuNode,
} from '../src/tui/menu-config.js';
import { REPORTS } from '../src/reports/registry.js';

function labels(nodes: MenuNode[]): string[] {
  return nodes.map((n) => n.label);
}

describe('menu-config', () => {
  // ---------------------------------------------------------------------------
  // visibleChildren
  // ---------------------------------------------------------------------------

  describe('visibleChildren', () => {
    it('returns all 9 top-level nodes when logged in', () => {
      const nodes = visibleChildren(MENU_TREE, true);
      expect(nodes).toHaveLength(9);
      expect(labels(nodes)).toEqual([
        'Login / Change server',
        'Sync',
        'Scan (dry-run preview)',
        'Convert videos to MP4',
        'Reports',
        'Settings',
        'Tools',
        'Help',
        'Quit',
      ]);
    });

    it('returns exactly [Login, Scan, Convert, Settings, Help, Quit] when logged out', () => {
      const nodes = visibleChildren(MENU_TREE, false);
      expect(labels(nodes)).toEqual([
        'Login / Change server',
        'Scan (dry-run preview)',
        'Convert videos to MP4',
        'Settings',
        'Help',
        'Quit',
      ]);
    });

    it('excludes Sync, Reports, and Tools entirely when logged out', () => {
      const nodes = visibleChildren(MENU_TREE, false);
      const ids = nodes.filter((n) => n.kind === 'submenu').map((n) => n.id);
      expect(ids).not.toContain('sync');
      expect(ids).not.toContain('reports');
      expect(ids).not.toContain('tools');
    });

    it('includes the Settings submenu when logged out because it has a loggedOut leaf', () => {
      const nodes = visibleChildren(MENU_TREE, false);
      const settings = nodes.find((n) => n.kind === 'submenu' && n.id === 'settings');
      expect(settings).toBeDefined();
    });

    it('within Settings when logged out, only the loggedOut leaves (organize + factory reset) are visible', () => {
      const settings = findSubmenu('settings')!;
      const nodes = visibleChildren(settings, false);
      expect(labels(nodes)).toEqual(['Organize folder by date', 'Factory reset (delete all local data)']);
    });

    it('within Settings when logged in, all settings leaves are visible', () => {
      const settings = findSubmenu('settings')!;
      const nodes = visibleChildren(settings, true);
      expect(labels(nodes)).toEqual([
        'Organize folder by date',
        'Manage folders',
        'Manage circles',
        'App settings',
        'Factory reset (delete all local data)',
      ]);
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
      const root = findSubmenu('root');
      expect(root).toBeDefined();
      expect(root!.label).toBe('Menu');
    });

    it('finds the sync submenu with its 3 action children', () => {
      const sync = findSubmenu('sync');
      expect(sync).toBeDefined();
      expect(sync!.children.every((c) => c.kind === 'action')).toBe(true);
      expect(labels(sync!.children)).toEqual([
        'Sync all folders',
        'Sync selected folders',
        'Retry failed files',
      ]);
    });

    it('finds the scan submenu with its 3 loggedOut action children', () => {
      const scan = findSubmenu('scan');
      expect(scan).toBeDefined();
      expect(scan!.children.every((c) => c.kind === 'action')).toBe(true);
      const actions = scan!.children.map((c) =>
        c.kind === 'action' ? c.action : null,
      );
      expect(actions).toEqual(['scan-all', 'scan-select', 'scan-report']);
      const nodes = visibleChildren(scan!, false);
      expect(nodes).toHaveLength(3);
    });

    it('finds the convert submenu with its 3 loggedOut action children', () => {
      const convert = findSubmenu('convert');
      expect(convert).toBeDefined();
      expect(convert!.children.every((c) => c.kind === 'action')).toBe(true);
      const actions = convert!.children.map((c) =>
        c.kind === 'action' ? c.action : null,
      );
      expect(actions).toEqual(['convert-file', 'convert-select', 'convert-all']);
      // Fully offline — every child is visible when logged out.
      expect(visibleChildren(convert!, false)).toHaveLength(3);
    });

    it('returns a reports submenu whose children match the report registry ids', () => {
      const reports = findSubmenu('reports');
      expect(reports).toBeDefined();
      const actions = reports!.children.map((c) =>
        c.kind === 'action' ? c.action : null,
      );
      const expected = REPORTS.map((r) => `report:${r.id}`);
      expect(actions).toEqual(expected);
    });

    it('returns a reports submenu whose child labels match the report registry labels', () => {
      const reports = findSubmenu('reports');
      expect(labels(reports!.children)).toEqual(REPORTS.map((r) => r.label));
    });
  });

  // ---------------------------------------------------------------------------
  // breadcrumb
  // ---------------------------------------------------------------------------

  describe('breadcrumb', () => {
    it("returns 'Menu' for the root id", () => {
      expect(breadcrumb('root')).toBe('Menu');
    });

    it("returns 'Menu › Sync' for the sync submenu", () => {
      expect(breadcrumb('sync')).toBe('Menu › Sync');
    });

    it("returns 'Menu › Reports' for the reports submenu", () => {
      expect(breadcrumb('reports')).toBe('Menu › Reports');
    });

    it("returns 'Menu › Settings' for the settings submenu", () => {
      expect(breadcrumb('settings')).toBe('Menu › Settings');
    });

    it('falls back to the root label for an unknown id', () => {
      expect(breadcrumb('nonexistent')).toBe('Menu');
    });
  });
});
