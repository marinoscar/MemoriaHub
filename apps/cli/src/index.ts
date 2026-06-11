#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { importCommand } from './commands/import.js';
import { syncCommand } from './commands/sync.js';
import { statusCommand } from './commands/status.js';
import { foldersCommand } from './commands/folders.js';
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

// If invoked with no arguments, show help (which triggers the banner).
if (process.argv.length === 2) {
  program.help();
}

program.parse(process.argv);
