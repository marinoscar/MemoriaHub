/**
 * tui/menu-config.ts — Hierarchical menu tree, gating, and navigation helpers.
 *
 * Pure data + pure functions (no JSX/React) so the tree and its visibility /
 * lookup / breadcrumb logic are trivially unit-testable and shared between the
 * root HomeMenu chrome and the generic Menu submenu renderer.
 */

import { REPORTS } from '../reports/registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MenuActionId =
  | 'login'
  | 'sync-all'
  | 'sync-select'
  | 'retry'
  | 'scan-all'
  | 'scan-select'
  | 'scan-report'
  | 'organize'
  | 'convert-file'
  | 'convert-select'
  | 'convert-all'
  | 'folders'
  | 'circles'
  | 'app-settings'
  | 'factory-reset'
  | 'jobs'
  | 'backup'
  | 'node-dashboard'
  | 'node-config'
  | 'node-start'
  | 'node-doctor'
  | 'node-register'
  | 'node-list'
  | 'node-logs'
  | 'node-service'
  | 'help'
  | 'quit'
  | `report:${string}`;

export interface MenuLeaf {
  kind: 'action';
  label: string;
  action: MenuActionId;
  /** Visible when logged out (default false → requires login). */
  loggedOut?: boolean;
}

export interface MenuSubmenu {
  kind: 'submenu';
  id: string;
  label: string;
  children: MenuNode[];
  loggedOut?: boolean;
}

export type MenuNode = MenuLeaf | MenuSubmenu;

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export const MENU_TREE: MenuSubmenu = {
  kind: 'submenu',
  id: 'root',
  label: 'Menu',
  children: [
    { kind: 'action', label: 'Login / Change server', action: 'login', loggedOut: true },
    {
      kind: 'submenu',
      id: 'sync',
      label: 'Sync',
      children: [
        { kind: 'action', label: 'Sync all folders', action: 'sync-all' },
        { kind: 'action', label: 'Sync selected folders', action: 'sync-select' },
        { kind: 'action', label: 'Retry failed files', action: 'retry' },
      ],
    },
    {
      // Scan is a fully offline dry-run preview — visible even when logged out.
      kind: 'submenu',
      id: 'scan',
      label: 'Scan (dry-run preview)',
      loggedOut: true,
      children: [
        { kind: 'action', label: 'Scan all folders', action: 'scan-all', loggedOut: true },
        { kind: 'action', label: 'Scan selected folders', action: 'scan-select', loggedOut: true },
        { kind: 'action', label: 'View last scan report', action: 'scan-report', loggedOut: true },
      ],
    },
    {
      kind: 'submenu',
      id: 'reports',
      label: 'Reports',
      children: REPORTS.map(
        (r): MenuLeaf => ({ kind: 'action', label: r.label, action: `report:${r.id}` }),
      ),
    },
    {
      kind: 'submenu',
      id: 'settings',
      label: 'Settings',
      children: [
        { kind: 'action', label: 'Manage folders', action: 'folders' },
        { kind: 'action', label: 'Manage circles', action: 'circles' },
        { kind: 'action', label: 'App settings', action: 'app-settings' },
        {
          kind: 'action',
          label: 'Factory reset (delete all local data)',
          action: 'factory-reset',
          loggedOut: true,
        },
      ],
    },
    {
      // Tools hosts offline file utilities (convert, organize) plus server tools
      // (jobs, backup). It stays visible when logged out thanks to its offline
      // children being loggedOut.
      kind: 'submenu',
      id: 'tools',
      label: 'Tools',
      loggedOut: true,
      children: [
        {
          // Convert is a fully offline local file operation — visible when logged out.
          kind: 'submenu',
          id: 'convert',
          label: 'Convert videos to MP4',
          loggedOut: true,
          children: [
            { kind: 'action', label: 'Convert a single file', action: 'convert-file', loggedOut: true },
            { kind: 'action', label: 'Convert selected folder(s)', action: 'convert-select', loggedOut: true },
            { kind: 'action', label: 'Convert all registered folders', action: 'convert-all', loggedOut: true },
          ],
        },
        { kind: 'action', label: 'Organize folder by date', action: 'organize', loggedOut: true },
        { kind: 'action', label: 'Job queue monitor', action: 'jobs' },
        { kind: 'action', label: 'Backup', action: 'backup' },
        {
          kind: 'submenu',
          id: 'node',
          label: 'Worker Node',
          children: [
            { kind: 'action', label: 'Node dashboard', action: 'node-dashboard' },
            { kind: 'action', label: 'Register node', action: 'node-register' },
            { kind: 'action', label: 'Start worker (background)', action: 'node-start' },
            { kind: 'action', label: 'Node config', action: 'node-config' },
            { kind: 'action', label: 'List nodes', action: 'node-list' },
            { kind: 'action', label: 'Node doctor', action: 'node-doctor' },
            { kind: 'action', label: 'Node logs', action: 'node-logs' },
            { kind: 'action', label: 'Node service (systemd)', action: 'node-service' },
          ],
        },
      ],
    },
    { kind: 'action', label: 'Help', action: 'help', loggedOut: true },
    { kind: 'action', label: 'Quit', action: 'quit', loggedOut: true },
  ],
};

// ---------------------------------------------------------------------------
// Helpers (pure, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Children of `node` visible for the current login state.
 * A leaf is visible when `loggedOut || isLoggedIn`.
 * A submenu is visible when it has ≥1 visible child (recursively).
 */
export function visibleChildren(node: MenuSubmenu, isLoggedIn: boolean): MenuNode[] {
  return node.children.filter((child) => {
    if (child.kind === 'action') {
      return Boolean(child.loggedOut) || isLoggedIn;
    }
    // submenu → visible only if it has at least one visible descendant
    return visibleChildren(child, isLoggedIn).length > 0;
  });
}

/** Depth-first search from the root for a submenu with the given id. */
export function findSubmenu(id: string): MenuSubmenu | undefined {
  function walk(node: MenuSubmenu): MenuSubmenu | undefined {
    if (node.id === id) return node;
    for (const child of node.children) {
      if (child.kind === 'submenu') {
        const found = walk(child);
        if (found) return found;
      }
    }
    return undefined;
  }
  return walk(MENU_TREE);
}

/**
 * Breadcrumb path from the root to the submenu with the given id, joined with
 * ' › '. Root → 'Menu'; sync → 'Menu › Sync'. Falls back to the root label
 * when the id is not found.
 */
export function breadcrumb(id: string): string {
  function walk(node: MenuSubmenu, trail: string[]): string[] | undefined {
    const here = [...trail, node.label];
    if (node.id === id) return here;
    for (const child of node.children) {
      if (child.kind === 'submenu') {
        const found = walk(child, here);
        if (found) return found;
      }
    }
    return undefined;
  }
  const path = walk(MENU_TREE, []);
  return (path ?? [MENU_TREE.label]).join(' › ');
}
