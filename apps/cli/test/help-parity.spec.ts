import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import type { Command } from 'commander';

import { APP_CLI_OPTIONS } from '../src/app.js';
import { nodeCommand } from '../src/commands/node.js';

// =============================================================================
// Zero feature loss, mechanically  (issue #577)
// =============================================================================
//
// fixtures/help-before holds `--help` of every command path of the 1.3.4 CLI
// (scripts/cli-help-snapshot.mjs). For each one, the command must still exist
// after the cutover and every option and subcommand it listed must still be
// declared. Wrapping of help text differs between commander 12 and 14 and the
// 1.3 banner line is gone, so the oracle is structure, not bytes.
// =============================================================================

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'help-before');

function section(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${title}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    out.push(line);
  }
  return out;
}

/** Long flags (`--face-provider`) and short flags (`-n`) from the "Options:" lines. */
function flagsOf(text: string): string[] {
  const flags: string[] = [];
  for (const line of section(text, 'Options')) {
    const m = /^ {2}((?:-[A-Za-z], )?--?[A-Za-z0-9][\w-]*)/.exec(line);
    if (m) flags.push(...m[1].split(', '));
  }
  return flags.filter((f) => f !== '-h' && f !== '--help' && f !== '--no-color' && f !== '-V' && f !== '--version');
}

function subsOf(text: string): string[] {
  return section(text, 'Commands')
    .map((l) => /^ {2}([a-z0-9][a-z0-9-]*)/.exec(l)?.[1])
    .filter((n): n is string => n !== undefined && n !== 'help');
}

function resolve(root: Command, path: string[]): Command | undefined {
  let cmd: Command | undefined = root;
  for (const name of path) cmd = cmd?.commands.find((c) => c.name() === name || c.aliases().includes(name));
  return cmd;
}

function declaredFlags(cmd: Command): string[] {
  return cmd.options.flatMap((o) => [o.short, o.long].filter((f): f is string => f !== undefined));
}

resetCliForTests();
const platform = createCli(APP_CLI_OPTIONS).program;
const legacyNode = nodeCommand();

const files = readdirSync(DIR).filter((f) => f !== '_root.txt');

describe('every 1.3.4 command path survives the cutover', () => {
  it('has the fixtures it expects', () => {
    expect(files.length).toBeGreaterThan(70);
  });

  for (const file of files) {
    const path = file.replace(/\.txt$/, '').split('__');
    it(`memoriahub ${path.join(' ')}`, () => {
      const before = readFileSync(join(DIR, file), 'utf8');
      // `node` stays the 1.3 implementation (legacy-flags rule node-group).
      const cmd = path[0] === 'node'
        ? resolve({ commands: [legacyNode] } as unknown as Command, path)
        : resolve(platform, path);
      expect(cmd).toBeDefined();
      const have = declaredFlags(cmd!);
      for (const flag of flagsOf(before)) {
        const bare = flag.replace(/^--no-/, '--');
        expect(have.some((h) => h === flag || h === bare || h === flag.replace('--', '--no-'))).toBe(true);
      }
      const names = cmd!.commands.map((c) => c.name());
      for (const sub of subsOf(before)) expect(names).toContain(sub);
    });
  }
});

describe('login is the platform built-in with the 1.3 flags', () => {
  it('keeps --server and --token', () => {
    const flags = declaredFlags(resolve(platform, ['login'])!);
    expect(flags).toEqual(expect.arrayContaining(['--server', '--token']));
  });
});
