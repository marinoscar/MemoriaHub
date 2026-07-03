/**
 * update-notice.ts — Headless "new version available" notice.
 *
 * Printed once, to stderr, before a headless command runs so it never corrupts
 * stdout (e.g. `--json` output).  Uses the shared cache-aware resolver, so it
 * only hits GitHub at most once per 24 h and never blocks or fails the CLI.
 */

import chalk from 'chalk';
import { getDb } from './db/database.js';
import { resolveUpdateStatus } from './version-check.js';

/**
 * Check for a newer published CLI version and, if one exists, print a one-line
 * warning to stderr.  Swallows every error — an update check must never block
 * or break a command.
 */
export async function printHeadlessUpdateNotice(currentVersion: string): Promise<void> {
  try {
    const status = await resolveUpdateStatus(getDb(), currentVersion);
    if (status.updateAvailable && status.latestVersion) {
      process.stderr.write(
        chalk.yellow(
          `⬆ Update available: ${status.latestVersion} (you have ${currentVersion}). ` +
            `Run 'git pull' in the MemoriaHub repo and rebuild the CLI.`,
        ) + '\n',
      );
    }
  } catch {
    // Never let an update check affect the command.
  }
}
