/**
 * test/tui/app-launch.spec.ts  (RETRO-F4, #582)
 *
 * Regression guard for the `launchTui()` re-exec bug, kept for the code that replaced
 * `launchTui`. The 1.3 `launchTui()` once called `maybeReexecWithHeapLimit()` (from
 * ../node/runtime-tuning.js) before rendering the Ink UI. That re-exec spawns a child
 * node process with a different heap-limit flag, and the re-exec'd child loses raw-mode
 * control over the terminal (`setRawMode EIO`), which broke the interactive TUI.
 *
 * The TUI is now opened by the platform (`createCli` -> bare invocation) and the app only
 * contributes screens, so the guard moves to the source: no module the TUI loads (the
 * screens, the routes, the registrations, the standalone `render-tui` launcher, `run.ts` and
 * `app.ts`) may call it. (`node start`'s use of it for the long-running daemon in
 * commands/node.ts is unrelated and correct.) The "TUI runs in-process" half is covered by
 * render-tui.spec.ts and the platform's own launch tests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the interactive TUI never re-execs to tune the V8 heap', () => {
  const files = [...sources(path.join(SRC, 'tui')), path.join(SRC, 'run.ts'), path.join(SRC, 'app.ts')];

  it('has TUI sources to guard', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files.map((f) => [path.relative(SRC, f), f]))('%s does not call maybeReexecWithHeapLimit', (_name, file) => {
    const code = fs
      .readFileSync(file as string, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/maybeReexecWithHeapLimit/);
  });
});
