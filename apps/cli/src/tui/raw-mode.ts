/**
 * tui/raw-mode.ts — safe Ink launch + raw-mode resolution.
 *
 * Ink calls `setRawMode` on stdin to capture keystrokes. On serial /
 * hypervisor / LXC consoles, or when stdin (fd0) is redirected while stdout is
 * still a TTY, that call throws `setRawMode EIO` and — because Ink surfaces it
 * synchronously from render — crashes the whole CLI with a stack trace.
 *
 * This module centralizes the fix:
 *   1. `canUseRawMode` probes a stream for a working `setRawMode`.
 *   2. `resolveInteractiveStdin` falls back to the controlling terminal
 *      (`/dev/tty`) when `process.stdin` itself can't do raw mode.
 *   3. `renderTui` is the single safe entry used by every top-level render
 *      site — it never lets a raw-mode failure hard-crash the process.
 */

import fs from 'node:fs';
import tty from 'node:tty';
import { render } from 'ink';
import type { ReactElement } from 'react';

/**
 * True only when `stream` is a TTY whose `setRawMode` actually works. The probe
 * toggles raw mode on then immediately off; any throw means the terminal can't
 * support it (serial/LXC/hypervisor consoles, redirected fds).
 */
export function canUseRawMode(stream: unknown): stream is NodeJS.ReadStream {
  const s = stream as Partial<NodeJS.ReadStream> | null | undefined;
  if (!s || !s.isTTY || typeof s.setRawMode !== 'function') return false;
  try {
    s.setRawMode(true);
    s.setRawMode(false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a stdin stream Ink can drive in raw mode, or null when none exists.
 *
 * Prefers `process.stdin`; when that can't do raw mode (fd0 redirected/broken)
 * it opens the process's controlling terminal directly via `/dev/tty`, which
 * often still works. Returns null on platforms/consoles with no usable tty
 * (e.g. Windows without `/dev/tty`, or a truly non-interactive console). Never
 * throws.
 */
export function resolveInteractiveStdin(): NodeJS.ReadStream | null {
  try {
    if (canUseRawMode(process.stdin)) return process.stdin;

    // fd0 may be redirected or broken even though a real controlling terminal
    // exists — try to attach to it directly.
    try {
      const fd = fs.openSync('/dev/tty', 'r');
      const stream = new tty.ReadStream(fd) as unknown as NodeJS.ReadStream;
      if (canUseRawMode(stream)) return stream;
      (stream as unknown as { destroy?: () => void }).destroy?.();
    } catch {
      /* no /dev/tty (e.g. Windows) — fall through to null */
    }
  } catch {
    /* defensive: never let stdin resolution throw */
  }
  return null;
}

/**
 * The single safe entry point for launching an Ink UI. Guards against a missing
 * TTY and against `setRawMode` failures, printing a friendly message and
 * returning cleanly instead of crashing with a stack trace in any of them.
 */
export async function renderTui(element: ReactElement): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stdout.write(
      'The interactive UI needs a real terminal. ' +
      'Use `memoriahub sync --all` or `memoriahub --help`.\n',
    );
    return;
  }

  const stdin = resolveInteractiveStdin();
  if (stdin === null) {
    process.stdout.write(
      "This terminal can't run the interactive UI (raw keyboard input is unavailable).\n" +
      'This usually happens on serial/hypervisor/LXC consoles. Options:\n' +
      '  • Connect over SSH with a PTY:   ssh -t <user>@<host> memoriahub\n' +
      '  • Or use headless commands:      memoriahub --help, memoriahub status, memoriahub node status\n',
    );
    return;
  }

  try {
    const instance = render(element, { stdin });
    await instance.waitUntilExit();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `The interactive UI could not start (${message}).\n` +
      'Try connecting over SSH with a PTY (ssh -t <user>@<host> memoriahub), ' +
      'or use headless commands like `memoriahub --help` / `memoriahub status`.\n',
    );
  }
}
