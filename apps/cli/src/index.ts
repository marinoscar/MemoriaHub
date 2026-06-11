#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { importCommand } from './commands/import.js';
import { syncCommand } from './commands/sync.js';
import { statusCommand } from './commands/status.js';
import { foldersCommand } from './commands/folders.js';
import { retryCommand } from './commands/retry.js';
import { settingsCommand } from './commands/settings.js';
import { printBanner } from './ui.js';

// ESM-safe package.json read: createRequire allows require() in ESM modules.
// dist/index.js → ../package.json resolves to apps/cli/package.json at runtime.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

// Honor --no-color before any other processing so chalk picks it up.
if (process.argv.includes('--no-color')) {
  process.env['NO_COLOR'] = '1';
}

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
program.addCommand(statusCommand());
program.addCommand(foldersCommand());
program.addCommand(retryCommand());
program.addCommand(settingsCommand());

// Bare invocation: if TTY launch TUI, else show help
if (process.argv.length === 2) {
  if (process.stdout.isTTY) {
    // Dynamic import keeps Ink/React out of headless code paths
    const { launchTui } = await import('./tui/app.js');
    await launchTui();
    process.exit(0);
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
    await launchTui();
  });

program.parse(process.argv);
