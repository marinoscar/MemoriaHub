/**
 * android/errors.ts — typed failures for `memoriahub android …` (issue #517).
 *
 * Every android command maps a failure to a process exit code through
 * {@link exitCodeFor}, so a script can tell "fix your machine" (6) from "you
 * typed it wrong" (2) from "the build/upload itself failed" (1):
 *
 *   1  FAILURE       a tool ran and failed, or the server refused the request
 *   2  USAGE         bad flags or arguments
 *   6  PRECONDITION  something is missing: no checkout, no SDK, no keystore,
 *                    not logged in — the message says how to fix it
 */

export const EXIT = {
  FAILURE: 1,
  USAGE: 2,
  PRECONDITION: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Base class: a message meant for the user, plus the exit code it implies. */
export class AndroidCliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = EXIT.FAILURE, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** Something the user must set up first (exit 6). */
export class PreconditionError extends AndroidCliError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, EXIT.PRECONDITION, options);
  }
}

/** Bad flags or arguments (exit 2). */
export class UsageError extends AndroidCliError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, EXIT.USAGE, options);
  }
}

/** The exit code an error implies: its own when it carries one, else 1. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof AndroidCliError) return error.exitCode;
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === 'number' && Number.isInteger(code) && code > 0 ? code : EXIT.FAILURE;
}

/** The message alone, for embedding in a sentence. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
