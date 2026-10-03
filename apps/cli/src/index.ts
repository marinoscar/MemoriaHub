#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
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
import { nodeCommand } from './commands/node.js';
import { workflowCommand } from './commands/workflow.js';
import { androidCommand } from './commands/android.js';
import { printBanner } from './ui.js';
import { printHeadlessUpdateNotice } from './update-notice.js';
import { NativeSqliteUnavailableError } from './db/native-sqlite-error.js';

// ESM-safe package.json read: createRequire allows require() in ESM modules.
// dist/index.js → ../package.json resolves to apps/cli/package.json at runtime.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

// Honor --no-color before any other processing so chalk picks it up.
if (process.argv.includes('--no-color')) {
  process.env['NO_COLOR'] = '1';
}

// A missing better-sqlite3 native binary (issue #541) is an install problem,
// not a bug: print its actionable message instead of a stack trace. Async
// command actions surface it as an unhandled rejection; anything else keeps
// Node's default crash behaviour (rethrown as an uncaught exception).
function exitOnNativeSqliteError(err: unknown): void {
  if (err instanceof NativeSqliteUnavailableError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
process.on('unhandledRejection', (reason) => {
  exitOnNativeSqliteError(reason);
  throw reason;
});

const program = new Command();

program
  .name('memoriahub')
  .description('Import and sync photos/videos into MemoriaHub')
  .version(pkg.version, '-V, --version', 'Print the installed version')
  .option('--no-color', 'Disable colored output (also respects NO_COLOR env)');

// Show banner on --help and bare invocation (no subcommand given).
program.addHelpText('beforeAll', () => {
  printBanner(pkg.version);
  return '';
});

program.addCommand(loginCommand());
program.addCommand(importCommand());
program.addCommand(syncCommand());
program.addCommand(scanCommand());
program.addCommand(organizeCommand());
program.addCommand(screenshotsCommand());
program.addCommand(convertCommand());
program.addCommand(dateInferCommand());
program.addCommand(statusCommand());
program.addCommand(foldersCommand());
program.addCommand(circlesCommand());
program.addCommand(retryCommand());
program.addCommand(settingsCommand());
program.addCommand(backupCommand());
program.addCommand(jobsCommand());
program.addCommand(reportsCommand());
program.addCommand(nodeCommand());
program.addCommand(workflowCommand());
program.addCommand(androidCommand());

// Bare invocation: if TTY launch TUI, else show help
if (process.argv.length === 2) {
  if (process.stdout.isTTY) {
    // Dynamic import keeps Ink/React out of headless code paths
    const { launchTui } = await import('./tui/app.js');
    await launchTui({ currentVersion: pkg.version });
    // Honour an exit code set by the TUI (e.g. a missing SQLite binary).
    process.exit();
  } else {
    program.help();
  }
}

// `menu` command — explicit entry to the interactive TUI
program
  .command('menu')
  .description('Launch the interactive terminal UI (requires a TTY)')
  .action(async () => {
    const { launchTui } = await import('./tui/app.js');
    await launchTui({ currentVersion: pkg.version });
  });

// Headless command invocation (a subcommand was given): surface a throttled,
// cached "update available" notice on stderr before running. Skipped for
// help/version flags so `--version`/`--help` stay instant and side-effect-free.
const argvRest = process.argv.slice(2);
const isHelpOrVersion = argvRest.some((a) =>
  ['-h', '--help', '-V', '--version', 'help'].includes(a),
);
if (!isHelpOrVersion) {
  await printHeadlessUpdateNotice(pkg.version);
}

try {
  program.parse(process.argv);
} catch (err) {
  exitOnNativeSqliteError(err);
  throw err;
}
