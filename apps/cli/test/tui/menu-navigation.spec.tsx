/**
 * test/tui/menu-navigation.spec.tsx  (RETRO-F4, #582)
 *
 * Replaces home-menu.spec.tsx, menu-nav.spec.tsx and backup-menu-nav.spec.tsx.
 * The 1.3 specs drove HomeMenu, Menu and a hand-built nav harness; these drive the real
 * platform router and menu (`renderTuiMenu`, `renderTuiRoute`) over MemoriaHub's registered
 * tree, so they cover the same behaviours on the code that now ships:
 *
 *   - logged out / logged in root menu, digit accelerators, Login moving into Settings;
 *   - breadcrumbs, subtitles, `▸` and `…`, the red destructive entry;
 *   - Esc goes back ONE level (route history), not to the root;
 *   - every entry opens a registered screen that loads (the 1.3 "dispatcher parity" test);
 *   - the one login gate, in place of the ten copied guards;
 *   - the header chips that replaced the home menu's identity box (circle, first-run hint).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import { createCli } from '@marinoscar/platform-cli';
import { BUILTIN_TUI_SCREENS, buildTuiMenuTree } from '@marinoscar/platform-cli/tui';
import { cleanup, renderTuiMenu, renderTuiRoute, stripAnsi } from '@marinoscar/platform-cli/tui/testing';

import { APP_CLI_OPTIONS } from '../../src/app.js';
import { ApiClient } from '../../src/api.js';
import { saveConfig } from '../../src/config.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { CIRCLE_SELECTION, getAppDb } from '../../src/tui/app-state.js';
import { APP_TUI_MENU, PLATFORM_HIDDEN_SCREENS } from '../../src/tui/menu.js';
import { APP_TUI_SCREENS } from '../../src/tui/screens.js';

const SCREENS = [
  ...BUILTIN_TUI_SCREENS.map((s) => ({
    route: s.route,
    order: s.order,
    label: s.route === 'deploy' ? 'Deploy  (this server)' : s.route,
    hidden: (PLATFORM_HIDDEN_SCREENS as readonly string[]).includes(s.route),
  })),
  ...APP_TUI_SCREENS.map((s) => ({ route: s.route, order: s.order, label: s.label })),
];

const savedStateDir = process.env['MEMORIAHUB_STATE_DIR'];
beforeAll(() => {
  process.env['MEMORIAHUB_STATE_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-menu-'));
  createCli(APP_CLI_OPTIONS);
});
afterAll(() => {
  if (savedStateDir === undefined) delete process.env['MEMORIAHUB_STATE_DIR'];
  else process.env['MEMORIAHUB_STATE_DIR'] = savedStateDir;
});
afterEach(() => cleanup());

function menu(loggedIn: boolean, section?: string) {
  return renderTuiMenu({ nodes: APP_TUI_MENU, screens: SCREENS, loggedIn, ...(section ? { section } : {}) });
}

describe('root menu', () => {
  it('logged out shows only Login, Scan, File Tools, Settings, Help and Deploy, then Quit', async () => {
    const m = await menu(false);
    expect(m.labels()).toEqual([
      'Login / Change server',
      'Scan ▸',
      'File Tools ▸',
      'Settings ▸',
      'Help',
      'Deploy  (this server)',
    ]);
    const frame = stripAnsi(await m.waitForFrame((f) => f.includes('Quit')));
    expect(frame).toContain('Quit');
    expect(frame).not.toContain('Sync ▸');
    expect(frame).not.toContain('Reports ▸');
  });

  it('logged in numbers the root items as digit accelerators in the documented order', async () => {
    const m = await menu(true);
    const frame = stripAnsi(await m.waitForFrame((f) => f.includes('Settings')));
    for (const [i, label] of ['Sync ▸', 'Scan ▸', 'Backup', 'Worker Node', 'Reports ▸', 'File Tools ▸', 'Settings ▸', 'Help'].entries()) {
      expect(frame).toContain(`${i + 1}. ${label}`);
    }
    expect(frame).not.toContain('Login / Change server');
    expect(frame).toContain('Quit');
  });

  it('keeps the platform screens MemoriaHub does not use out of the menu', async () => {
    for (const loggedIn of [false, true]) {
      const frame = stripAnsi(await (await menu(loggedIn)).waitForFrame((f) => f.includes('Quit')));
      for (const hidden of ['Call an endpoint', 'Status', 'Jobs queue', 'Worker node  (this machine)', 'Logout']) {
        expect(frame).not.toContain(hidden);
      }
    }
  });

  it('selects an item directly by its digit accelerator', async () => {
    const m = await menu(true);
    await m.waitForFrame((f) => f.includes('Backup'));
    await m.press('3'); // 3. Backup
    expect(await m.waitForFrame((f) => f.includes('[opened backup-dashboard]'))).toContain('backup-dashboard');
  });

  it('ignores a digit past the end of the list', async () => {
    const m = await menu(false);
    await m.waitForFrame((f) => f.includes('Quit'));
    await m.press('9');
    expect(stripAnsi(m.lastFrame() ?? '')).not.toContain('[opened');
  });

  it('Enter opens the highlighted item', async () => {
    const m = await menu(false);
    await m.waitForFrame((f) => f.includes('Login / Change server'));
    await m.press('enter'); // Login is pre-highlighted
    expect(await m.waitForFrame((f) => f.includes('[opened memoriahub-login]'))).toContain('memoriahub-login');
  });
});

describe('submenus', () => {
  it('Enter on Sync opens its section with the breadcrumb and its three entries', async () => {
    const m = await menu(true);
    await m.waitForFrame((f) => f.includes('Sync ▸'));
    await m.press('enter');
    const frame = stripAnsi(await m.waitForFrame((f) => f.includes('Home › Sync')));
    expect(frame).toContain('1. Sync all folders…');
    expect(frame).toContain('2. Sync selected folders…');
    expect(frame).toContain('3. Retry failed files');
  });

  it('jumps straight into a submenu with its digit accelerator', async () => {
    const m = await menu(true);
    await m.waitForFrame((f) => f.includes('Scan ▸'));
    await m.press('2');
    const frame = stripAnsi(await m.waitForFrame((f) => f.includes('Home › Scan')));
    expect(frame).toContain('1. Scan all folders');
    expect(frame).toContain('3. View last scan report');
  });

  it('shows the tree-supplied subtitle instead of the generic navigation hint', async () => {
    const m = await menu(true, 'scan');
    const frame = stripAnsi(await m.waitForFrame((f) => f.includes('Home › Scan')));
    expect(frame).toContain('Dry-run preview — reports what a sync would do, without uploading');
  });

  it('draws the destructive entry with its ellipsis under the nested File Tools breadcrumb', async () => {
    const m = await menu(true, 'screenshots');
    const frame = stripAnsi(await m.waitForFrame((f) => f.includes('Find & delete screenshots')));
    expect(frame).toContain('Home › File Tools › Find/Clean Screenshots');
    expect(frame).toContain('Find & delete screenshots…');
  });

  it('a digit opens that entry (Sync: 3 is Retry failed files)', async () => {
    const m = await menu(true, 'sync');
    await m.waitForFrame((f) => f.includes('Retry failed files'));
    await m.press('3');
    expect(await m.waitForFrame((f) => f.includes('[opened retry]'))).toContain('retry');
  });

  it('Esc from a submenu goes back to the parent menu, one level at a time', async () => {
    const m = await menu(true);
    await m.waitForFrame((f) => f.includes('File Tools ▸'));
    await m.press('6'); // File Tools
    await m.waitForFrame((f) => f.includes('Home › File Tools'));
    await m.press('3'); // Find/Clean Screenshots
    await m.waitForFrame((f) => f.includes('Home › File Tools › Find/Clean Screenshots'));
    await m.press('esc');
    const parent = stripAnsi(await m.waitForFrame((f) => f.includes('Home › File Tools') && !f.includes('Find & delete')));
    expect(parent).not.toContain('Home › File Tools › Find/Clean Screenshots');
    await m.press('esc');
    const root = stripAnsi(await m.waitForFrame((f) => f.includes('Settings ▸') && !f.includes('Home ›')));
    expect(root).toContain('Worker Node');
  });
});

describe('every entry opens a screen', () => {
  const tree = buildTuiMenuTree(APP_TUI_MENU, SCREENS);

  it('each entry route is registered, and its screen loads', async () => {
    const byRoute = new Map(APP_TUI_SCREENS.map((s) => [s.route, s]));
    const builtins = new Set(BUILTIN_TUI_SCREENS.map((s) => s.route));
    for (const entry of tree.entries) {
      if (builtins.has(entry.route)) continue;
      const screen = byRoute.get(entry.route);
      expect(screen).toBeDefined();
      const component = await screen!.load!();
      expect(typeof component).toBe('function');
    }
  });

  it('every MemoriaHub screen is opened by an entry, so none is drawn at the root by default', () => {
    const opened = new Set(tree.entries.filter((e) => !e.synthesised).map((e) => e.route));
    for (const screen of APP_TUI_SCREENS) expect(opened.has(screen.route)).toBe(true);
  });

  it('the 1.3 action ids are the routes, so each key path is unchanged', () => {
    const routes = new Set(tree.entries.map((e) => e.route));
    for (const action of [
      'sync-all', 'sync-select', 'retry', 'scan-all', 'scan-select', 'scan-report', 'backup-dashboard',
      'node', 'jobs-monitor', 'convert-file', 'convert-select',
      'convert-all', 'organize', 'screenshots-find', 'screenshots-move', 'screenshots-delete', 'date-infer-diagnose',
      'date-infer-apply', 'folders', 'circles', 'app-settings', 'android', 'factory-reset', 'help',
      'report-overview', 'report-runs', 'report-storage', 'report-duplicates',
    ]) {
      expect(routes).toContain(action);
    }
  });
});

describe('the login gate', () => {
  it.each(['circles', 'sync-all', 'backup-dashboard', 'jobs-monitor'])(
    'shows one not-logged-in notice instead of %s when logged out',
    async (route) => {
      const screen = await renderTuiRoute(route, { session: { loggedIn: false }, useRegistered: true });
      const frame = stripAnsi(await screen.waitForFrame((f) => f.trim().length > 0));
      expect(frame).toContain('[l] login');
      expect(frame).toContain('back');
    },
  );

  it.each(['android', 'factory-reset', 'help', 'scan-all'])('%s needs no login', async (route) => {
    const screen = await renderTuiRoute(route, { session: { loggedIn: false }, useRegistered: true });
    const frame = stripAnsi(await screen.waitForFrame((f) => f.trim().length > 0));
    expect(frame).not.toContain('[l] login');
  });
});

describe('header chips replace the home menu identity box', () => {
  it('shows the first-run folder hint while no folder is registered, then drops it', async () => {
    const empty = await renderTuiMenu({ nodes: APP_TUI_MENU, screens: SCREENS, loggedIn: true, useRegistered: true });
    const frame = stripAnsi(await empty.waitForFrame((f) => f.includes('Folders:')));
    expect(frame).toMatch(/Folders:\s+none\s+registered/);
    expect(frame).toMatch(/Settings\s+›\s+Manage\s+folders/);
    cleanup();

    new FolderRepo(getAppDb()).add({ path: '/tmp/photos-alpha' });
    const withFolder = await renderTuiMenu({ nodes: APP_TUI_MENU, screens: SCREENS, loggedIn: true, useRegistered: true });
    await withFolder.waitForFrame((f) => f.includes('Quit'));
    await new Promise((r) => setTimeout(r, 100));
    expect(stripAnsi(withFolder.lastFrame() ?? '')).not.toContain('Folders:');
  });

  it('never shows the hint when logged out', async () => {
    const m = await renderTuiMenu({ nodes: APP_TUI_MENU, screens: SCREENS, loggedIn: false, useRegistered: true });
    await m.waitForFrame((f) => f.includes('Quit'));
    await new Promise((r) => setTimeout(r, 100));
    expect(stripAnsi(m.lastFrame() ?? '')).not.toContain('Folders:');
  });

  it('lists the circles with the active one first, so it is the header chip', async () => {
    saveConfig({ serverUrl: 'http://server.example.test', pat: 'tok', activeCircleId: 'c2' });
    const spy = jest
      .spyOn(ApiClient.prototype, 'listCircles')
      .mockResolvedValue([{ id: 'c1', name: 'Circle Alpha' }, { id: 'c2', name: 'Circle Beta' }] as never);
    try {
      const circles = await CIRCLE_SELECTION.load({ loggedIn: true, serverUrl: undefined, signal: new AbortController().signal });
      expect(circles.map((c) => CIRCLE_SELECTION.display(c))).toEqual(['Circle Beta', 'Circle Alpha']);
    } finally {
      spy.mockRestore();
    }
  });

  it('has no circles when logged out of the CLI config', async () => {
    fs.rmSync(path.join(process.env['MEMORIAHUB_STATE_DIR'] as string, 'config.json'), { force: true });
    expect(await CIRCLE_SELECTION.load({ loggedIn: false, serverUrl: undefined, signal: new AbortController().signal })).toEqual([]);
  });
});
