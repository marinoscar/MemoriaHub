/**
 * tui/menu-slots.ts — the root menu's banner and footnote (RETRO-F4, #582), through the
 * platform's menu slots (`createCli({ tuiMenuRoot })`, seam EnterpriseAppBase#1115).
 *
 * They restore two things the 1.3 home menu drew above its entries: the MemoriaHub
 * wordmark with its tagline, and the yellow "Update available" line. Plain text only
 * (a slot never loads ink), so this file is safe to import on every run.
 *
 * The wordmark is 61 columns wide; the platform truncates a slot line to the terminal
 * width rather than wrapping it, so below that width the banner falls back to a
 * one-line title instead of a cut-off drawing.
 */
import type { TuiMenuSlotContext, TuiMenuSlots } from '@marinoscar/platform-cli/tui';

import type { UpdateStatus } from '../version-check.js';
import { readVersion } from '../version.js';

/** The 1.3 home-menu wordmark. */
export const BANNER_ART: readonly string[] = [
  ' __  __                            _       _   _       _',
  '|  \\/  | ___ _ __ ___   ___  _ __(_) __ _| | | |_   _| |__',
  "| |\\/| |/ _ \\ '_ ` _ \\ / _ \\| '__| |/ _` | |_| | | | | '_ \\",
  '| |  | |  __/ | | | | | (_) | |  | | (_| |  _  | |_| | |_) |',
  '|_|  |_|\\___|_| |_| |_|\\___/|_|  |_|\\__,_|_| |_|\\__,_|_.__/',
];

export const TAGLINE = 'Import and sync photos/videos to your MemoriaHub server';

/** Inside the menu frame's border and padding, the wordmark needs this many columns. */
export const BANNER_MIN_COLUMNS = 68;

/** The banner: the wordmark and tagline on a wide terminal, a one-line title otherwise. */
export function rootBanner({ columns }: Pick<TuiMenuSlotContext, 'columns'>): readonly string[] {
  if (columns >= BANNER_MIN_COLUMNS) return [...BANNER_ART, `  ${TAGLINE}`];
  return ['MemoriaHub'];
}

/** The footnote: the update notice once the `update-info` loader found a newer release. */
export function rootFootnote({ state }: Pick<TuiMenuSlotContext, 'state'>): string | undefined {
  const update = state['update-info'] as UpdateStatus | undefined;
  if (!update?.updateAvailable) return undefined;
  return `⬆ Update available: ${update.latestVersion ?? '?'} (you have ${readVersion()}) — run 'git pull' in the MemoriaHub repo and rebuild the CLI`;
}

/** What `createCli({ tuiMenuRoot })` takes. */
export const APP_TUI_MENU_ROOT: TuiMenuSlots = {
  banner: { content: rootBanner },
  footnote: { content: rootFootnote, color: 'warning' },
};
