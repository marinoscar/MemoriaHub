#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login';
import { importCommand } from './commands/import';
import { syncCommand } from './commands/sync';
import { statusCommand } from './commands/status';
import { printBanner } from './ui';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };

// Honor --no-color before any other processing so picocolors picks it up.
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

// If invoked with no arguments, show help (which triggers the banner).
if (process.argv.length === 2) {
  program.help();
}

program.parse(process.argv);
