import { Command } from 'commander';

/**
 * `menu` — kept so `memoriahub menu` and `memoriahub --help` read as they did.
 *
 * The terminal UI is the platform TUI and opens for a bare `memoriahub` in a real
 * terminal. `run.ts` rewrites a lone `menu` to that bare invocation
 * (extensions/legacy-flags.ts, rule `menu`), so this action only runs when the
 * word is reached some other way, where it points at the bare command.
 */
export function menuCommand(): Command {
  return new Command('menu')
    .description('Launch the interactive terminal UI (requires a TTY)')
    .action(() => {
      process.stdout.write('Run `memoriahub` with no arguments to open the interactive menu (requires a TTY).\n');
    });
}
