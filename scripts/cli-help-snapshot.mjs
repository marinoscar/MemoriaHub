#!/usr/bin/env node
// Parity oracle for the CLI cutover (RETRO-F3, #577): records `--help` for the
// root command and, recursively, for every subcommand listed under "Commands:".
//
//   node scripts/cli-help-snapshot.mjs --out apps/cli/test/fixtures/help-before [--bin apps/cli/dist/index.js]
//
// Output is deterministic: NO_COLOR=1, no TTY, no update check. One file per
// command path, e.g. `node__service__install.txt`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const out = resolve(opt('--out', 'apps/cli/test/fixtures/help-snapshot'));
const bin = resolve(opt('--bin', 'apps/cli/dist/index.js'));
mkdirSync(out, { recursive: true });

function help(path) {
  const r = spawnSync(process.execPath, [bin, ...path, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', MEMORIAHUB_NO_UPDATE_CHECK: '1', CI: '1', COLUMNS: '100' },
  });
  return `${r.stdout ?? ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`;
}

function subcommands(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^Commands:\s*$/.test(l));
  if (start < 0) return [];
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const m = /^ {2}([a-z0-9][a-z0-9-]*)/.exec(line);
    if (m && m[1] !== 'help') names.push(m[1]);
  }
  return names;
}

let count = 0;
function walk(path) {
  const text = help(path);
  writeFileSync(join(out, `${path.length ? path.join('__') : '_root'}.txt`), text);
  count += 1;
  for (const sub of subcommands(text)) walk([...path, sub]);
}
walk([]);
console.log(`wrote ${count} help files to ${out}`);
