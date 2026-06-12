/**
 * open-browser.ts — Best-effort browser opener, shared by both the CLI login
 * command and the interactive TUI LoginScreen.
 *
 * Uses only Node built-ins (child_process + os) — no npm dependency.
 * Silently swallows all errors; the verification URL is always printed in
 * the UI so the user can open it manually if the auto-open fails.
 */

import { execFile } from 'child_process';
import * as os from 'os';

/**
 * Best-effort open a URL in the default browser.
 * Silently swallows all errors — the URL is always printed in the UI.
 */
export function openBrowser(url: string): void {
  const platform = os.platform();
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // `cmd /c start` handles spaces and special chars correctly
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    // Linux / other POSIX
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    execFile(cmd, args, { timeout: 5000 }, () => {
      // ignore all errors and exit codes
    });
  } catch {
    // ignore synchronous errors (e.g. ENOENT on minimal systems)
  }
}
