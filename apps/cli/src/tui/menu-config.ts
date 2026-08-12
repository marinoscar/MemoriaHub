/**
 * tui/menu-config.ts — Hierarchical menu tree, gating, and navigation helpers.
 *
 * Pure data + pure functions (no JSX/React) so the tree and its visibility /
 * lookup / breadcrumb / label logic are trivially unit-testable and shared
 * between the root HomeMenu chrome and the generic Menu submenu renderer.
 *
 * Two conventions live here rather than in the renderers, so the two renderers
 * can never drift (issue #413):
 *   - `menuItemLabel()` owns EVERY label decoration: the '▸' submenu chevron,
 *     the '…' multi-step suffix, and the '1.'–'9.' digit accelerator prefix.
 *   - `loggedOut` CASCADES from a submenu to its descendants, so a new leaf
 *     added under an offline submenu cannot silently vanish for logged-out
 *     users by forgetting the flag.
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
  | 'screenshots-find'
  | 'screenshots-move'
  | 'screenshots-delete'
  | 'date-infer-diagnose'
  | 'date-infer-apply'
  | 'convert-file'
  | 'convert-select'
  | 'convert-all'
  | 'folders'
  | 'circles'
  | 'app-settings'
  | 'factory-reset'
  | 'jobs'
  | 'backup-dashboard'
  | 'backup-run'
  | 'backup-verify'
  | 'backup-settings'
  | 'node-dashboard'
  | 'node-config'
  | 'node-start'
  | 'node-stop'
  | 'node-doctor'
  | 'node-register'
  | 'node-enroll'
  | 'node-install-deps'
  | 'node-list'
  | 'node-logs'
  | 'node-service'
  | 'help'
  | 'quit'
  | `report:${string}`;

/** Fields shared by both node kinds. */
interface MenuNodeBase {
  label: string;
  /**
   * Visible when logged out. Omitted → INHERITED from the nearest ancestor
   * that sets it (default false → requires login). An explicit `false` opts a
   * single child out of an offline parent's cascade.
   */
  loggedOut?: boolean;
  /**
   * Hide this entry once the user IS logged in. Used only by the root
   * 'Login / Change server' leaf, which moves into Settings after login so the
   * root menu stays focused on day-to-day work.
   */
  hideWhenLoggedIn?: boolean;
  /** Optional item colour, e.g. 'red' for destructive actions. Presentation only. */
  color?: string;
}

export interface MenuLeaf extends MenuNodeBase {
  kind: 'action';
  action: MenuActionId;
  /**
   * This action opens a further input step (a folder picker, a date filter, a
   * path prompt) before anything happens. Rendered with a trailing '…' so a
   * scary-sounding entry like 'Find & delete screenshots' reads as the prompt
   * it actually is.
   */
  ellipsis?: boolean;
}

export interface MenuSubmenu extends MenuNodeBase {
  kind: 'submenu';
  id: string;
  children: MenuNode[];
  /** Replaces the generic navigation hint under the submenu title. */
  subtitle?: string;
}

export type MenuNode = MenuLeaf | MenuSubmenu;

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/**
 * Reports submenu children: the report registry, plus the live job-queue
 * monitor — which is a live report over the server queue, not a "tool".
 */
const REPORT_CHILDREN: MenuNode[] = [
  ...REPORTS.map((r): MenuLeaf => ({ kind: 'action', label: r.label, action: `report:${r.id}` })),
  { kind: 'action', label: 'Job queue monitor', action: 'jobs' },
];

export const MENU_TREE: MenuSubmenu = {
  kind: 'submenu',
  id: 'root',
  label: 'Menu',
  children: [
    // Logged out only — once logged in, 'Login / Change server' lives under
    // Settings so the root menu is day-to-day work only.
    {
      kind: 'action',
      label: 'Login / Change server',
      action: 'login',
      loggedOut: true,
      hideWhenLoggedIn: true,
    },
    {
      kind: 'submenu',
      id: 'sync',
      label: 'Sync',
      children: [
        { kind: 'action', label: 'Sync all folders', action: 'sync-all', ellipsis: true },
        { kind: 'action', label: 'Sync selected folders', action: 'sync-select', ellipsis: true },
        { kind: 'action', label: 'Retry failed files', action: 'retry' },
      ],
    },
    {
      // Scan is a fully offline dry-run preview — visible even when logged out.
      // The parenthetical that used to live in the label is now the submenu's
      // subtitle, so the root menu row stays short.
      kind: 'submenu',
      id: 'scan',
      label: 'Scan',
      subtitle: 'Dry-run preview — reports what a sync would do, without uploading',
      loggedOut: true,
      children: [
        { kind: 'action', label: 'Scan all folders', action: 'scan-all' },
        { kind: 'action', label: 'Scan selected folders', action: 'scan-select', ellipsis: true },
        { kind: 'action', label: 'View last scan report', action: 'scan-report' },
      ],
    },
    // Backup is a single leaf straight into the dashboard: run / verify /
    // settings are all reachable from inside it, so a submenu here would be an
    // extra keystroke on every visit for three duplicate entries.
    { kind: 'action', label: 'Backup', action: 'backup-dashboard' },
    {
      kind: 'submenu',
      id: 'node',
      label: 'Worker Node',
      subtitle: 'Daily operations first; first-run setup below',
      children: [
        { kind: 'action', label: 'Node dashboard', action: 'node-dashboard' },
        { kind: 'action', label: 'Start worker (background)', action: 'node-start' },
        { kind: 'action', label: 'Stop worker', action: 'node-stop' },
        { kind: 'action', label: 'Node logs', action: 'node-logs' },
        { kind: 'action', label: 'Node doctor', action: 'node-doctor' },
        // ---- first-run setup ----
        // Enroll re-authenticates on its own (device flow) and swaps the stored
        // PAT for a durable `nod_` credential, but it stays login-gated so the
        // Worker Node submenu does not surface on the logged-out root menu —
        // root's own Login entry is the logged-out entry point.
        { kind: 'action', label: 'Enroll node (login + credential)', action: 'node-enroll' },
        { kind: 'action', label: 'Install dependencies (Linux)', action: 'node-install-deps' },
        { kind: 'action', label: 'Register node', action: 'node-register' },
        { kind: 'action', label: 'Node config', action: 'node-config' },
        { kind: 'action', label: 'List nodes', action: 'node-list' },
        { kind: 'action', label: 'Node service (systemd)', action: 'node-service' },
      ],
    },
    {
      kind: 'submenu',
      id: 'reports',
      label: 'Reports',
      children: REPORT_CHILDREN,
    },
    {
      // Purely offline local-file utilities — every child works logged out, so
      // the flag lives here once and cascades (see visibleChildren).
      kind: 'submenu',
      id: 'file-tools',
      label: 'File Tools',
      subtitle: 'Offline local-file utilities — no server connection required',
      loggedOut: true,
      children: [
        {
          kind: 'submenu',
          id: 'convert',
          label: 'Convert videos to MP4',
          children: [
            { kind: 'action', label: 'Convert a single file', action: 'convert-file', ellipsis: true },
            { kind: 'action', label: 'Convert selected folder(s)', action: 'convert-select', ellipsis: true },
            { kind: 'action', label: 'Convert all registered folders', action: 'convert-all' },
          ],
        },
        { kind: 'action', label: 'Organize folder by date', action: 'organize', ellipsis: true },
        {
          kind: 'submenu',
          id: 'screenshots',
          label: 'Find/Clean Screenshots',
          children: [
            { kind: 'action', label: 'Find screenshots (list only)', action: 'screenshots-find', ellipsis: true },
            { kind: 'action', label: 'Find & move screenshots', action: 'screenshots-move', ellipsis: true },
            {
              kind: 'action',
              label: 'Find & delete screenshots',
              action: 'screenshots-delete',
              ellipsis: true,
              color: 'red',
            },
          ],
        },
        {
          kind: 'submenu',
          id: 'date-infer',
          label: 'Date Inference',
          children: [
            { kind: 'action', label: 'Diagnose (report only)', action: 'date-infer-diagnose', ellipsis: true },
            { kind: 'action', label: 'Infer & write dates', action: 'date-infer-apply', ellipsis: true },
          ],
        },
      ],
    },
    {
      kind: 'submenu',
      id: 'settings',
      label: 'Settings',
      children: [
        { kind: 'action', label: 'Manage folders', action: 'folders' },
        { kind: 'action', label: 'Manage circles', action: 'circles' },
        { kind: 'action', label: 'App settings', action: 'app-settings' },
        // Root hides Login once logged in; it stays reachable here so a
        // logged-in user can still re-auth or point the CLI at another server.
        { kind: 'action', label: 'Login / Change server', action: 'login' },
        {
          kind: 'action',
          label: 'Factory reset (delete all local data)',
          action: 'factory-reset',
          loggedOut: true,
          color: 'red',
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
 *
 * `loggedOut` CASCADES: a child with no explicit flag inherits its parent's
 * effective value, so every descendant of an offline submenu is visible when
 * logged out without repeating the flag on each leaf. A child may still opt
 * out of the cascade with an explicit `loggedOut: false`.
 *
 * A submenu is visible when it has ≥1 visible child (recursively).
 *
 * @param inheritedLoggedOut effective `loggedOut` of `node`'s ancestors —
 *   callers pass nothing; the recursion threads it.
 */
export function visibleChildren(
  node: MenuSubmenu,
  isLoggedIn: boolean,
  inheritedLoggedOut = false,
): MenuNode[] {
  const effective = node.loggedOut ?? inheritedLoggedOut;
  return node.children.filter((child) => {
    if (isLoggedIn && child.hideWhenLoggedIn) return false;
    const childLoggedOut = child.loggedOut ?? effective;
    if (child.kind === 'action') {
      return childLoggedOut || isLoggedIn;
    }
    // submenu → visible only if it has at least one visible descendant
    return visibleChildren(child, isLoggedIn, effective).length > 0;
  });
}

/**
 * The exact string a renderer should print for `node`.
 *
 * Owns all three decorations so HomeMenu and the generic Menu cannot drift:
 *   - submenus get a trailing ' ▸'
 *   - `ellipsis` leaves get a trailing '…' (opens a further input step)
 *   - a 1-based `position` of 1–9 gets an 'N. ' accelerator prefix; positions
 *     past 9 get equal-width padding instead so the column stays aligned.
 */
export function menuItemLabel(node: MenuNode, position?: number): string {
  const base =
    node.kind === 'submenu'
      ? `${node.label} ▸`
      : node.ellipsis
        ? `${node.label}…`
        : node.label;
  if (position === undefined) return base;
  const prefix = position >= 1 && position <= 9 ? `${position}. ` : '   ';
  return `${prefix}${base}`;
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
