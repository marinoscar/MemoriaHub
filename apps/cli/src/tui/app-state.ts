/**
 * tui/app-state.ts — the state MemoriaHub's TUI screens share, registered with the
 * platform TUI framework (RETRO-F4, #582).
 *
 * Ink-free on purpose: `createCli` imports this module for every invocation, and
 * `--help` or a headless command must never load ink.
 *
 *   - selection `circle`  the header chip `[Circle: <name>]` (replaces the 1.3 home
 *     menu's "Circle:" line). The active circle (`activeCircleId` in the CLI config)
 *     is listed first, so it is the current one after every (re)load.
 *   - selection `folders`  the first-run hint chip (no folder registered yet).
 *   - state loader `update-info`  the "newer version" status the Help screen shows.
 *   - `getAppDb()`  the local SQLite handle every screen that reads folders, runs
 *     or settings uses. One handle per process, as the 1.3 app root held one.
 */
import type BetterSqlite3 from 'better-sqlite3';
import type { TuiSelectionRegistration, TuiStateLoaderRegistration } from '@marinoscar/platform-cli/tui';

import { ApiClient, type Circle } from '../api.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { resolveUpdateStatus, type UpdateStatus } from '../version-check.js';
import { readVersion } from '../version.js';

let sharedDb: BetterSqlite3.Database | null = null;

/** The process-wide local database; opened on first use. */
export function getAppDb(): BetterSqlite3.Database {
  sharedDb ??= openDb();
  return sharedDb;
}

/** Drops the shared handle (factory reset deletes the file); the next `getAppDb()` opens a fresh one. */
export function resetAppDb(): void {
  try {
    sharedDb?.close();
  } catch {
    /* already closed */
  }
  sharedDb = null;
}

/** Test seam: install a database (e.g. `:memory:`) as the shared handle. */
export function setAppDbForTests(db: BetterSqlite3.Database | null): void {
  sharedDb = db;
}

/** The circles of the logged-in user, the active one first. Empty when logged out or unreachable. */
export async function loadCirclesActiveFirst(): Promise<Circle[]> {
  const config = loadConfig();
  if (!config) return [];
  let circles: Circle[];
  try {
    circles = await new ApiClient(config).listCircles();
  } catch {
    return [];
  }
  const active = circles.find((c) => c.id === config.activeCircleId);
  return active ? [active, ...circles.filter((c) => c.id !== active.id)] : circles;
}

export const CIRCLE_SELECTION: TuiSelectionRegistration<Circle> = {
  id: 'circle',
  label: 'Circle',
  load: loadCirclesActiveFirst,
  display: (circle) => circle.name,
  keyOf: (circle) => circle.id,
  persist: 'none',
};

/** The one item of the `folders` selection: a header chip that is a first-run hint, not a choice. */
export interface FolderHint {
  readonly text: string;
}

/**
 * Number of registered folders, or null when the local database cannot be read (the hint then
 * stays hidden rather than guessing).
 */
export function countRegisteredFolders(): number | null {
  try {
    return new FolderRepo(getAppDb()).list().length;
  } catch {
    return null;
  }
}

/**
 * The 1.3 home menu showed "No folders registered — start with Settings › Manage folders" in its
 * identity box for a logged-in user with zero folders. The platform menu has no free text slot,
 * so the hint is the header chip `[Folders: ...]`: it has one item while the user is logged in
 * with no folder and none otherwise (a chip with no item is not drawn).
 */
export const FOLDERS_HINT_SELECTION: TuiSelectionRegistration<FolderHint> = {
  id: 'folders',
  label: 'Folders',
  load: async ({ loggedIn }) =>
    loggedIn && countRegisteredFolders() === 0
      ? [{ text: 'none registered — start with Settings › Manage folders' }]
      : [],
  display: (hint) => hint.text,
  persist: 'none',
};

export const UPDATE_INFO_STATE: TuiStateLoaderRegistration<UpdateStatus> = {
  id: 'update-info',
  // Best effort and never throws: the interactive UI checks GitHub live on each launch, so
  // Help always shows the newest published version; the result also refreshes the shared cache.
  load: async () => resolveUpdateStatus(getAppDb(), readVersion(), { force: true }),
};

export const APP_TUI_SELECTIONS: readonly TuiSelectionRegistration<any>[] = [CIRCLE_SELECTION, FOLDERS_HINT_SELECTION];
export const APP_TUI_STATE_LOADERS: readonly TuiStateLoaderRegistration<UpdateStatus>[] = [UPDATE_INFO_STATE];
