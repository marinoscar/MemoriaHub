/**
 * commands/settings.ts — `memoriahub settings` command group.
 *
 * Subcommands:
 *   settings list
 *   settings get <key>
 *   settings set <key> <value>
 *
 * Only numeric positive-integer settings are validated (concurrency, attempts_cap).
 */

import { Command } from 'commander';
import { getDb } from '../db/database.js';
import { SettingsRepo } from '../repo/settings.js';
import { ui } from '../ui.js';

// ---------------------------------------------------------------------------
// Keys that must be positive integers
// ---------------------------------------------------------------------------

const INTEGER_KEYS = new Set(['concurrency', 'attempts_cap']);

// All known setting keys with defaults for display
const KNOWN_SETTINGS: Array<{ key: string; default: unknown; description: string }> = [
  { key: 'concurrency',  default: 3, description: 'Max concurrent upload workers' },
  { key: 'attempts_cap', default: 5, description: 'Max upload attempts before a file is blocked' },
];

// ---------------------------------------------------------------------------
// settings list
// ---------------------------------------------------------------------------

function listCmd(): Command {
  const cmd = new Command('list');
  cmd.description('Print all settings and their current values');

  cmd.action(() => {
    const repo = new SettingsRepo(getDb());

    ui.blank();
    ui.step('Settings');
    ui.blank();

    for (const s of KNOWN_SETTINGS) {
      const current = repo.get(s.key, s.default);
      ui.line(`  ${s.key.padEnd(16)} = ${JSON.stringify(current)}    (default: ${JSON.stringify(s.default)})  ${s.description}`);
    }

    ui.blank();
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// settings get
// ---------------------------------------------------------------------------

function getCmd(): Command {
  const cmd = new Command('get');
  cmd
    .description('Get the current value of a setting')
    .argument('<key>', 'Setting key');

  cmd.action((key: string) => {
    const known = KNOWN_SETTINGS.find((s) => s.key === key);
    if (!known) {
      ui.error(`Unknown setting: ${key}`);
      ui.info(`Known settings: ${KNOWN_SETTINGS.map((s) => s.key).join(', ')}`);
      process.exit(1);
    }

    const repo  = new SettingsRepo(getDb());
    const value = repo.get(key, known.default);
    process.stdout.write(`${JSON.stringify(value)}\n`);
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// settings set
// ---------------------------------------------------------------------------

function setCmd(): Command {
  const cmd = new Command('set');
  cmd
    .description('Set the value of a setting')
    .argument('<key>',   'Setting key')
    .argument('<value>', 'New value');

  cmd.action((key: string, rawValue: string) => {
    const known = KNOWN_SETTINGS.find((s) => s.key === key);
    if (!known) {
      ui.error(`Unknown setting: ${key}`);
      ui.info(`Known settings: ${KNOWN_SETTINGS.map((s) => s.key).join(', ')}`);
      process.exit(1);
    }

    // Parse and validate
    let parsed: unknown;
    if (INTEGER_KEYS.has(key)) {
      const n = parseInt(rawValue, 10);
      if (isNaN(n) || n < 1 || String(n) !== rawValue.trim()) {
        ui.error(`${key} must be a positive integer (got: ${rawValue})`);
        process.exit(1);
      }
      parsed = n;
    } else {
      // Generic: try JSON parse, fall back to string
      try {
        parsed = JSON.parse(rawValue);
      } catch {
        parsed = rawValue;
      }
    }

    const repo = new SettingsRepo(getDb());
    repo.set(key, parsed);
    ui.success(`${key} = ${JSON.stringify(parsed)}`);
  });

  return cmd;
}

// ---------------------------------------------------------------------------
// Export the `settings` command group
// ---------------------------------------------------------------------------

export function settingsCommand(): Command {
  const cmd = new Command('settings');
  cmd.description('View and update CLI settings (concurrency, attempts cap, etc.)');

  cmd.addCommand(listCmd());
  cmd.addCommand(getCmd());
  cmd.addCommand(setCmd());

  return cmd;
}
