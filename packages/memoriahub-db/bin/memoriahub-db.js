#!/usr/bin/env node
'use strict';

// The `memoriahub-db` command. The logic lives in src/bin (compiled to dist/bin) so
// it is typed and unit-tested; this file only wires it to the process.
const { runMemoriahubDb } = require('../dist/bin/index.js');

runMemoriahubDb(
  process.argv.slice(2),
  {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
  { env: process.env, cwd: process.cwd() },
).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`memoriahub-db: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);
