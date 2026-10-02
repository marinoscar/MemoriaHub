/**
 * android/prompt.ts — the two interactive questions the android commands ask.
 *
 * Both answer "No"/nothing when stdin is not a terminal, so a script (or the
 * TUI, which spawns this CLI with a piped stdin) never hangs on a question:
 * it must pass `--yes` or the environment variable instead.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';

export function canPrompt(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/** y/N question on stderr; defaults to No. */
export async function confirm(question: string): Promise<boolean> {
  if (!canPrompt()) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** A password prompt that echoes nothing. */
export async function promptSecret(question: string): Promise<string> {
  if (!canPrompt()) return '';
  process.stderr.write(question);
  let muted = true;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve) => rl.question('', resolve));
  } finally {
    muted = false;
    rl.close();
    process.stderr.write('\n');
  }
}
