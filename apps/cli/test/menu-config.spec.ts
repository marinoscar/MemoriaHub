/**
 * test/menu-config.spec.ts
 *
 * Pure unit tests for MemoriaHub's menu tree (src/tui/menu.ts), re-pointed at the
 * platform helpers that replaced the 1.3 `menu-config.ts` (RETRO-F4, #582):
 * `buildTuiMenuTree`, `visibleTuiMenuChildren`, `tuiMenuItemLabel` and
 * `tuiBreadcrumb`. No Ink/React involved: plain data + function tests.
 *
 * Every assertion of the 1.3 spec is kept (issue #413's restructure: the flattened
 * root, the CASCADING `loggedOut` gate and the single shared label decoration),
 * with the vocabulary of the platform tree: a "submenu" is a section, an "action" an
 * entry, the 1.3 action id is the entry's route, and the breadcrumb root reads
 * `Home` instead of `Menu` (documented in docs/platform-adoption/tui-parity.md).
 * The platform adds a `Deploy` entry at the root; its own login, invoke, status,
 * jobs, node and logout screens are hidden (`tuiHiddenScreens`).
 */
import {
  BUILTIN_TUI_SCREENS,
  buildTuiMenuTree,
  tuiBreadcrumb,
  tuiMenuItemLabel,
  visibleTuiMenuChildren,
  type TuiMenuNode,
  type TuiMenuTree,
  type TuiMenuTreeEntry,
  type TuiMenuTreeNode,
  type TuiMenuTreeSection,
} from '@marinoscar/platform-cli/tui';

import { APP_TUI_MENU, PLATFORM_HIDDEN_SCREENS, reportRoute } from '../src/tui/menu.js';
import { APP_TUI_SCREENS } from '../src/tui/screens.js';
import { REPORTS } from '../src/reports/registry.js';

const SCREENS = [
  ...BUILTIN_TUI_SCREENS.map((s) => ({
    route: s.route,
    order: s.order,
    label: s.route === 'deploy' ? 'Deploy  (this server)' : s.route,
    hidden: (PLATFORM_HIDDEN_SCREENS as readonly string[]).includes(s.route),
  })),
  ...APP_TUI_SCREENS.map((s) => ({ route: s.route, order: s.order, label: s.label })),
];

const TREE: TuiMenuTree = buildTuiMenuTree(APP_TUI_MENU, SCREENS);

function section(id: string): TuiMenuTreeSection {
  const found = TREE.sections.get(id);
  if (!found) throw new Error(`no section ${id}`);
  return found;
}

function labelOf(node: TuiMenuTreeNode): string {
  return typeof node.label === 'string' ? node.label : node.label({ loggedIn: true });
}

function visible(id: string, loggedIn: boolean): TuiMenuTreeNode[] {
  return visibleTuiMenuChildren(id, { loggedIn }, TREE);
}

function labels(nodes: readonly TuiMenuTreeNode[]): string[] {
  return nodes.map(labelOf);
}

function routes(nodes: readonly TuiMenuTreeNode[]): (string | null)[] {
  return nodes.map((n) => (n.kind === 'entry' ? n.route : null));
}

function allEntries(): TuiMenuTreeEntry[] {
  return [...TREE.entries];
}

describe('menu tree (platform helpers)', () => {
  // ---------------------------------------------------------------------------
  // visible children: root shape
  // ---------------------------------------------------------------------------

  describe('visibleTuiMenuChildren', () => {
    it('returns the 9 restructured top-level nodes, in order, then the platform Deploy entry, when logged in', () => {
      expect(labels(visible('root', true))).toEqual([
        'Sync',
        'Scan',
        'Backup',
        'Worker Node',
        'Reports',
        'File Tools',
        'Settings',
        'Help',
        'Deploy  (this server)',
      ]);
    });

    it('no longer exposes a Tools submenu at any level', () => {
      expect(TREE.sections.get('tools')).toBeUndefined();
      expect(labels(visible('root', true))).not.toContain('Tools');
    });

    it('hides Login at the root once logged in (it moves into Settings)', () => {
      expect(labels(visible('root', true))).not.toContain('Login / Change server');
      expect(labels(visible('settings', true))).toContain('Login / Change server');
    });

    it('returns exactly [Login, Scan, File Tools, Settings, Help, Deploy] when logged out (Quit is the router\'s)', () => {
      expect(labels(visible('root', false))).toEqual([
        'Login / Change server',
        'Scan',
        'File Tools',
        'Settings',
        'Help',
        'Deploy  (this server)',
      ]);
    });

    it('hides the login-gated Sync / Backup / Worker Node / Reports entries when logged out', () => {
      const shown = labels(visible('root', false));
      expect(shown).not.toContain('Sync');
      expect(shown).not.toContain('Backup');
      expect(shown).not.toContain('Worker Node');
      expect(shown).not.toContain('Reports');
    });

    it('within Settings when logged out, only the Android and factory-reset loggedOut leaves are visible', () => {
      expect(labels(visible('settings', false))).toEqual([
        'Android app (build, publish, releases)',
        'Factory reset (delete all local data)',
      ]);
    });

    it('within Settings when logged in, all settings leaves are visible', () => {
      expect(labels(visible('settings', true))).toEqual([
        'Manage folders',
        'Manage circles',
        'App settings',
        'Login / Change server',
        'Android app (build, publish, releases)',
        'Factory reset (delete all local data)',
      ]);
    });

    it('keeps the platform login, invoke, status, jobs, node and logout screens out of the menu in both states', () => {
      for (const loggedIn of [false, true]) {
        const shown = routes(visible('root', loggedIn));
        for (const hidden of PLATFORM_HIDDEN_SCREENS) expect(shown).not.toContain(hidden);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // loggedOut cascade (issue #413 §2.1)
  // ---------------------------------------------------------------------------

  describe('loggedOut cascade', () => {
    it('makes a leaf under an offline submenu visible logged out WITHOUT its own flag', () => {
      const declared = APP_TUI_MENU.filter((n) => n.kind === 'entry' && n.parent === 'convert');
      expect(declared).toHaveLength(3);
      expect(declared.every((n) => n.loggedOut === undefined)).toBe(true);
      expect(visible('convert', false)).toHaveLength(3);
    });

    it('cascades through File Tools to every nested descendant when logged out', () => {
      expect(labels(visible('file-tools', false))).toEqual([
        'Convert videos to MP4',
        'Organize folder by date',
        'Find/Clean Screenshots',
        'Date Inference',
      ]);
      for (const id of ['convert', 'screenshots', 'date-infer']) {
        expect(visible(id, false).length).toBe(section(id).children.length);
      }
    });

    it('drops per-leaf loggedOut duplication under the offline submenus', () => {
      for (const id of ['convert', 'screenshots', 'date-infer']) {
        const declaredSection = APP_TUI_MENU.find((n) => n.kind === 'section' && n.id === id);
        expect(declaredSection?.loggedOut).toBeUndefined();
        expect(APP_TUI_MENU.some((n) => n.parent === id && n.loggedOut !== undefined)).toBe(false);
      }
    });

    it('lets a child opt OUT of an inherited cascade with an explicit loggedOut: false', () => {
      const nodes: TuiMenuNode[] = [
        { kind: 'section', id: 'test-parent', label: 'Parent', order: 1, loggedOut: true },
        { kind: 'entry', id: 'inherits', parent: 'test-parent', label: 'Inherits', order: 1, route: 'help' },
        { kind: 'entry', id: 'opts-out', parent: 'test-parent', label: 'Opts out', order: 2, route: 'help', loggedOut: false },
      ];
      const tree = buildTuiMenuTree(nodes, SCREENS);
      expect(labels(visibleTuiMenuChildren('test-parent', { loggedIn: false }, tree))).toEqual(['Inherits']);
      expect(labels(visibleTuiMenuChildren('test-parent', { loggedIn: true }, tree))).toEqual(['Inherits', 'Opts out']);
    });

    it('defaults to login-required when no ancestor sets loggedOut', () => {
      expect(visible('sync', false)).toHaveLength(0);
      expect(visible('sync', true)).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // tuiMenuItemLabel (issue #413 §2.3 + §2.5 + §2.7)
  // ---------------------------------------------------------------------------

  describe('tuiMenuItemLabel', () => {
    const sync = section('sync');
    const [syncAll, , retry] = sync.children as TuiMenuTreeEntry[];

    it('appends the chevron to a submenu label', () => {
      expect(tuiMenuItemLabel(sync)).toBe('Sync ▸');
    });

    it('appends an ellipsis to a leaf that opens a further input step', () => {
      expect(tuiMenuItemLabel(syncAll!)).toBe('Sync all folders…');
    });

    it('leaves an immediate action bare', () => {
      expect(tuiMenuItemLabel(retry!)).toBe('Retry failed files');
    });

    it('prefixes a 1-based position of 1–9 with a digit accelerator', () => {
      expect(tuiMenuItemLabel(retry!, 1)).toBe('1. Retry failed files');
      expect(tuiMenuItemLabel(sync, 9)).toBe('9. Sync ▸');
    });

    it('pads positions past 9 so the label column stays aligned', () => {
      expect(tuiMenuItemLabel(retry!, 10)).toBe('   Retry failed files');
    });

    it('omits the prefix entirely when no position is given', () => {
      expect(tuiMenuItemLabel(retry!)).toBe('Retry failed files');
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
      const withEllipsis = allEntries().filter((e) => e.ellipsis && !e.synthesised).map((e) => e.route);
      expect(withEllipsis.sort()).toEqual(expected.sort());
    });

    it('leaves immediate actions and dashboards without an ellipsis', () => {
      const immediate = ['retry', 'scan-all', 'scan-report', 'convert-all', 'backup-dashboard'];
      for (const entry of allEntries()) {
        if (immediate.includes(entry.route)) expect(entry.ellipsis).toBe(false);
      }
    });

    it('renders the two destructive entries in red', () => {
      const red = allEntries().filter((e) => e.color === 'red').map((e) => e.route);
      expect(red.sort()).toEqual(['factory-reset', 'screenshots-delete']);
    });
  });

  // ---------------------------------------------------------------------------
  // Restructured branches
  // ---------------------------------------------------------------------------

  describe('Backup', () => {
    it('is a single root leaf opening the dashboard, not a submenu', () => {
      const backup = visible('root', true).find((n) => labelOf(n) === 'Backup')!;
      expect(backup.kind).toBe('entry');
      expect(backup.kind === 'entry' && backup.route).toBe('backup-dashboard');
      expect(TREE.sections.get('backup')).toBeUndefined();
    });
  });

  describe('Reports', () => {
    it('lists the report registry followed by the job queue monitor', () => {
      const reports = section('reports');
      expect(routes(reports.children)).toEqual([...REPORTS.map((r) => reportRoute(r.id)), 'jobs-monitor']);
      expect(labels(reports.children)).toEqual([...REPORTS.map((r) => r.label), 'Job queue monitor']);
    });
  });

  describe('Worker Node', () => {
    it('orders daily operations first and first-run setup last', () => {
      expect(labels(section('node').children)).toEqual([
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
      expect(routes(section('node').children)).toEqual(
        expect.arrayContaining(['node-enroll', 'node-install-deps', 'node-stop']),
      );
    });

    it('stays hidden when logged out (root Login is the logged-out entry point)', () => {
      expect(visible('node', false)).toHaveLength(0);
    });
  });

  describe('Scan', () => {
    it('drops the parenthetical from the label and carries it as a subtitle', () => {
      const scan = section('scan');
      expect(labelOf(scan)).toBe('Scan');
      expect(scan.subtitle).toContain('Dry-run preview');
    });
  });

  // ---------------------------------------------------------------------------
  // sections by id
  // ---------------------------------------------------------------------------

  describe('sections', () => {
    it('returns undefined for an unknown id', () => {
      expect(TREE.sections.get('does-not-exist')).toBeUndefined();
    });

    it('finds the root section by id', () => {
      expect(TREE.sections.get('root')).toBe(TREE.root);
    });

    it('finds the sync submenu with its 3 action children', () => {
      const sync = section('sync');
      expect(sync.children.every((c) => c.kind === 'entry')).toBe(true);
      expect(labels(sync.children)).toEqual(['Sync all folders', 'Sync selected folders', 'Retry failed files']);
    });

    it('finds the scan submenu with its 3 action children', () => {
      const scan = section('scan');
      expect(routes(scan.children)).toEqual(['scan-all', 'scan-select', 'scan-report']);
      expect(visible('scan', false)).toHaveLength(3);
    });

    it('finds the convert submenu nested under File Tools', () => {
      expect(routes(section('convert').children)).toEqual(['convert-file', 'convert-select', 'convert-all']);
    });
  });

  // ---------------------------------------------------------------------------
  // breadcrumb
  // ---------------------------------------------------------------------------

  describe('tuiBreadcrumb', () => {
    it("returns 'Home' for the root id (the 1.3 menu said 'Menu')", () => {
      expect(tuiBreadcrumb('root', { loggedIn: true }, TREE)).toBe('Home');
    });

    it('returns the one-level path for a root submenu', () => {
      const crumb = (id: string): string => tuiBreadcrumb(id, { loggedIn: true }, TREE);
      expect(crumb('sync')).toBe('Home › Sync');
      expect(crumb('reports')).toBe('Home › Reports');
      expect(crumb('settings')).toBe('Home › Settings');
      expect(crumb('node')).toBe('Home › Worker Node');
      expect(crumb('file-tools')).toBe('Home › File Tools');
    });

    it('returns the nested path under File Tools for convert', () => {
      expect(tuiBreadcrumb('convert', { loggedIn: true }, TREE)).toBe('Home › File Tools › Convert videos to MP4');
    });

    it('falls back to the root label for an unknown id', () => {
      expect(tuiBreadcrumb('nonexistent', { loggedIn: true }, TREE)).toBe('Home');
    });
  });
});
