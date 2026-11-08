import { Command } from 'commander';

import { readVersion } from '../version.js';

/**
 * `menu` — explicit entry to the full MemoriaHub terminal UI (requires a TTY).
 *
 * A bare `memoriahub` opens the platform's menu, which has a "MemoriaHub menu"
 * entry that lands in the same place. This command is the direct route and
 * behaves exactly as it did on 1.3.
 * PLATFORM-ADOPTION-SHIM(RETRO-F4): the legacy TUI is re-hosted by RETRO-F4.
 */
export function menuCommand(): Command {
  return new Command('menu')
    .description('Launch the interactive terminal UI (requires a TTY)')
    .action(async () => {
      // Dynamic import keeps ink/React out of every headless code path.
      const { launchTui } = await import('../tui/app.js');
      await launchTui({ currentVersion: readVersion() });
    });
}
