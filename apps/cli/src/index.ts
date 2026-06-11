#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand } from './commands/login';
import { importCommand } from './commands/import';
import { syncCommand } from './commands/sync';
import { statusCommand } from './commands/status';

const program = new Command();

program
  .name('memoriahub')
  .description('Import and sync photos/videos into MemoriaHub')
  .version('0.1.0');

program.addCommand(loginCommand());
program.addCommand(importCommand());
program.addCommand(syncCommand());
program.addCommand(statusCommand());

program.parse(process.argv);
