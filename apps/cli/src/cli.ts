#!/usr/bin/env node
import { EXIT } from '@marinoscar/platform-cli';

import { describeError, runApp } from './run.js';

// =============================================================================
// Executable entry point  (issue #577, RETRO-F3)
// =============================================================================
//
// The ONLY module with side effects at import time, and deliberately almost
// empty: the CLI is `createCli(APP_CLI_OPTIONS)` (app.ts) run by `runApp`
// (run.ts). `process.exitCode` is set and main RETURNS, never `process.exit()`:
// exiting would truncate output still queued on a pipe.
// =============================================================================

async function main(): Promise<void> {
  process.exitCode = await runApp(process.argv.slice(2));
}

// An unhandled rejection is a bug in this CLI; convert Node's stack trace into
// the one-line failure every other error gets.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${describeError(reason)}\n`);
  process.exitCode = EXIT.FAILURE;
});

void main();
