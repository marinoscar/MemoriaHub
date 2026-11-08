import { githubRawManifest, type CreateCliOptions } from '@marinoscar/platform-cli';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';
import type { Command } from 'commander';

import { importCommand } from './commands/import.js';
import { syncCommand } from './commands/sync.js';
import { scanCommand } from './commands/scan.js';
import { organizeCommand } from './commands/organize.js';
import { screenshotsCommand } from './commands/screenshots.js';
import { convertCommand } from './commands/convert.js';
import { dateInferCommand } from './commands/date-infer.js';
import { statusCommand } from './commands/status.js';
import { foldersCommand } from './commands/folders.js';
import { circlesCommand } from './commands/circles.js';
import { retryCommand } from './commands/retry.js';
import { settingsCommand } from './commands/settings.js';
import { backupCommand } from './commands/backup.js';
import { jobsCommand } from './commands/jobs.js';
import { reportsCommand } from './commands/reports.js';
import { workflowCommand } from './commands/workflow.js';
import { androidCommand } from './commands/android.js';
import { menuCommand } from './commands/menu.js';
import { readVersion } from './version.js';
import { APP_DEPLOY_CHECKS } from './extensions/deploy-checks.js';
import { APP_DEPLOY_STEPS } from './extensions/deploy-steps.js';
import { APP_ENV_SPEC } from './extensions/env-spec.js';
import { APP_TUI_MENU, PLATFORM_HIDDEN_SCREENS } from './tui/menu.js';
import { APP_TUI_SCREENS } from './tui/screens.js';
import { APP_TUI_SELECTIONS, APP_TUI_STATE_LOADERS } from './tui/app-state.js';
import { BRAND_HEX } from './brand.js';

// =============================================================================
// MemoriaHub's CLI, composed on the platform engine  (issue #577, RETRO-F3)
// =============================================================================
//
// `createCli(APP_CLI_OPTIONS)` is the whole CLI. The platform supplies `init`,
// `login`, `api`, `config` and `deploy` plus the TUI shell; this file adds what
// the platform does not have: MemoriaHub's own commands (`extraCommands`), the
// deploy steps/checks that are MemoriaHub's, the stream routes of the host
// proxy, the metadata of the app's `.env` keys and the start-up update notice.
//
// The `node` group is NOT here: the platform has a built-in `node` and a name
// may be registered once. Until RETRO-C10 moves MemoriaHub's executors onto the
// platform engine, `run.ts` routes `memoriahub node ...` to the 1.3 command
// (extensions/legacy-flags.ts, rule `node-group`).
// =============================================================================

/** The repository slug (`packages/shared/identity.json` `repoSlug`). */
export { readVersion };

export const REPO_SLUG = 'marinoscar/MemoriaHub';

/**
 * App routes the VPS host proxy must stream (no buffering, long timeout), on top
 * of the platform's three. `POST /api/search/agent` is the agentic-search SSE
 * stream. (`/api/notifications/stream` is already a platform stream path;
 * registering it again would be a duplicate.) No trailing slash: nginx answers a
 * prefix location's URI without the slash with a 301.
 */
export const APP_STREAM_PATHS: readonly string[] = ['/api/search/agent'];

/**
 * The manifests the deploy `version` step versions. `apps/cli/package.json` is
 * deliberately absent: the CLI keeps its own version. The first entry is the
 * version source.
 */
export const APP_VERSIONED_MANIFESTS: readonly string[] = [
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
];

/** The one-liner that updates an installed CLI: the installer, re-run from `main`. */
export const APP_UPGRADE_HINT = `curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh | bash`;

/**
 * The start-up update notice (replaces the 1.3 `update-notice.ts`): at most one
 * check a day, a single stderr line, silent in CI, without a TTY, for `--json`,
 * `--help`/`--version` and `MEMORIAHUB_NO_UPDATE_CHECK=1`. `apps/cli/package.json`
 * on `main` is the version `install.sh` would install.
 */
export const APP_UPDATE_NOTICE: NonNullable<CreateCliOptions['updateNotice']> = {
  latestVersion: githubRawManifest({ repo: REPO_SLUG, ref: 'main', path: 'apps/cli/package.json' }),
  upgradeHint: APP_UPGRADE_HINT,
};

/** Every 1.3 command factory the app keeps, in the order `--help` lists them. */
export const APP_COMMAND_FACTORIES: readonly (() => Command)[] = [
  importCommand,
  syncCommand,
  scanCommand,
  organizeCommand,
  screenshotsCommand,
  convertCommand,
  dateInferCommand,
  statusCommand,
  foldersCommand,
  circlesCommand,
  retryCommand,
  settingsCommand,
  backupCommand,
  jobsCommand,
  reportsCommand,
  workflowCommand,
  androidCommand,
  menuCommand,
];

/** Adapts a command factory to the platform's registration shape. */
function register(factory: () => Command): CliCommandRegistration {
  return (program) => {
    program.addCommand(factory());
  };
}

export const APP_CLI_OPTIONS: CreateCliOptions = {
  identity: {
    name: 'memoriahub',
    displayName: 'MemoriaHub CLI',
    productName: 'MemoriaHub',
    repoSlug: REPO_SLUG,
  },
  version: readVersion(),
  extraCommands: APP_COMMAND_FACTORIES.map(register),
  // The TUI: MemoriaHub's menu tree, screens, header chip and shared data (RETRO-F4, #582).
  tuiScreens: [...APP_TUI_SCREENS],
  tuiMenu: [...APP_TUI_MENU],
  tuiHiddenScreens: [...PLATFORM_HIDDEN_SCREENS],
  tuiSelections: [...APP_TUI_SELECTIONS],
  tuiStateLoaders: [...APP_TUI_STATE_LOADERS],
  tuiTheme: { brand: BRAND_HEX },
  deploySteps: [...APP_DEPLOY_STEPS],
  deployChecks: [...APP_DEPLOY_CHECKS],
  envSpecFragments: [APP_ENV_SPEC],
  proxy: { streamPaths: APP_STREAM_PATHS },
  deploy: { versionedManifests: APP_VERSIONED_MANIFESTS },
  updateNotice: APP_UPDATE_NOTICE,
};
