/**
 * tui/render-tui.ts — the safe ink launch for the two standalone dashboards that
 * commands open on their own (`memoriahub jobs`, `memoriahub scan`). The menu
 * itself is the platform's TUI; its terminal handling (raw-mode probe, the
 * `/dev/tty` fallback) is `resolveInteractiveStdin` from
 * `@marinoscar/platform-cli/tui`, which replaced the 1.3 `raw-mode.ts`.
 */
import { render } from 'ink';
import type { ReactElement } from 'react';
import { resolveInteractiveStdin } from '@marinoscar/platform-cli/tui';

/**
 * Renders `element` on a terminal ink can drive in raw mode. Never lets a raw-mode
 * failure crash the process with a stack trace: with no real terminal it prints how to
 * run headless and returns.
 */
export async function renderTui(element: ReactElement): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stdout.write(
      'The interactive UI needs a real terminal. ' +
      'Use `memoriahub sync --all` or `memoriahub --help`.\n',
    );
    return;
  }

  const terminal = resolveInteractiveStdin();
  if (terminal === null) {
    process.stdout.write(
      "This terminal can't run the interactive UI (raw keyboard input is unavailable).\n" +
      'This usually happens on serial/hypervisor/LXC consoles. Options:\n' +
      '  • Connect over SSH with a PTY:   ssh -t <user>@<host> memoriahub\n' +
      '  • Or use headless commands:      memoriahub --help, memoriahub status, memoriahub node status\n',
    );
    return;
  }

  try {
    const instance = render(element, { stdin: terminal.stream });
    await instance.waitUntilExit();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `The interactive UI could not start (${message}).\n` +
      'Try connecting over SSH with a PTY (ssh -t <user>@<host> memoriahub), ' +
      'or use headless commands like `memoriahub --help` / `memoriahub status`.\n',
    );
  } finally {
    terminal.release();
  }
}
