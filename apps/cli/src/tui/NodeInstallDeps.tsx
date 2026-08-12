/**
 * tui/NodeInstallDeps.tsx — Ink screen for `memoriahub node install-deps`.
 *
 * `node install-deps` is the one-command Linux dependency installer (ffmpeg,
 * the npm native compute libraries, tesseract OCR data, Docker + the local
 * compreface-core sidecar) and is the step that has to succeed BEFORE
 * `Register node` produces a node that can actually do work — yet it had no
 * TUI entry at all (issue #413).
 *
 * IMPORTANT — why this screen SHELLS OUT instead of calling node/install-deps.ts
 * directly: that module writes its per-step progress with `ui.*` straight to
 * stdout, and Ink owns stdout for its render loop (the same hazard documented
 * at length in NodeService.tsx's header). Calling it in-process would
 * interleave raw writes with Ink's frames and corrupt the display. Instead we
 * spawn THIS SAME CLI as a child with piped stdio and render its output as
 * Ink <Text> rows — the "shell out with live output" v1 the issue explicitly
 * sanctions.
 *
 * Two run modes, because the real run needs privileges:
 *   - Plan (--dry-run): announces every command it would run, changes nothing.
 *     Always safe, so it is the default/highlighted choice.
 *   - Install: the real thing. The child's stdin is NOT inherited (Ink owns
 *     the terminal), so `sudo` cannot prompt for a password — exactly the same
 *     constraint the headless command already has, since node/install-deps.ts
 *     runs every privileged command through a piped `spawn`. This screen
 *     therefore probes `sudo -n true` up front and, when a password WOULD be
 *     required, says so with the concrete fix rather than letting the run fail
 *     opaquely three steps in.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props + local types
// ---------------------------------------------------------------------------

export interface NodeInstallDepsProps {
  onBack: () => void;
}

type Step = 'menu' | 'running' | 'done';
type Mode = 'plan' | 'install';

/** Most recent output lines kept in memory — enough to see the tail of a run. */
const MAX_LINES = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when `sudo` can run without prompting (already root, passwordless
 * sudoers entry, or a live credential cache). `sudo -n` never prompts: it
 * fails immediately instead, which is exactly the probe we want.
 */
export function sudoIsNonInteractive(): boolean {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return true;
  try {
    const res = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** argv for re-invoking this same CLI's `node install-deps`. */
export function installDepsArgv(mode: Mode): { cmd: string; args: string[] } {
  const entry = path.resolve(process.argv[1] ?? '');
  const args = [entry, 'node', 'install-deps'];
  if (mode === 'plan') args.push('--dry-run');
  return { cmd: process.execPath, args };
}

function splitLines(chunk: string): string[] {
  return chunk.split('\n').map((l) => l.replace(/\r$/, ''));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeInstallDeps({ onBack }: NodeInstallDepsProps): React.ReactElement {
  const isLinux = process.platform === 'linux';
  const [step, setStep] = useState<Step>('menu');
  const [mode, setMode] = useState<Mode>('plan');
  const [lines, setLines] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [sudoOk, setSudoOk] = useState<boolean | null>(null);

  const mountedRef = useRef(true);
  const childRef = useRef<ReturnType<typeof spawn> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Never leave an installer running against a screen that is gone.
      childRef.current?.kill('SIGTERM');
    };
  }, []);

  // Probe sudo once, lazily — spawnSync is fast but still a process.
  useEffect(() => {
    if (!isLinux) return;
    setSudoOk(sudoIsNonInteractive());
  }, [isLinux]);

  const appendChunk = useCallback((chunk: string): void => {
    if (!mountedRef.current) return;
    setLines((prev) => {
      // Blank lines are dropped rather than preserved: the installer's output
      // is line-oriented per step, and a bounded scrolling box gains nothing
      // from reproducing its vertical spacing exactly.
      const next = [...prev, ...splitLines(chunk).filter((l) => l.length > 0)];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  const run = useCallback(
    (which: Mode): void => {
      setMode(which);
      setLines([]);
      setExitCode(null);
      setStep('running');

      const { cmd, args } = installDepsArgv(which);
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, {
          // stdin ignored on purpose — Ink owns the terminal, so an inherited
          // stdin would fight its raw-mode input handling.
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        });
      } catch (err) {
        appendChunk(`Failed to start installer: ${err instanceof Error ? err.message : String(err)}`);
        setExitCode(1);
        setStep('done');
        return;
      }
      childRef.current = child;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => appendChunk(c));
      child.stderr?.on('data', (c: string) => appendChunk(c));
      child.on('error', (err) => appendChunk(`Installer error: ${err.message}`));
      child.on('close', (code) => {
        childRef.current = null;
        if (!mountedRef.current) return;
        setExitCode(code ?? 1);
        setStep('done');
      });
    },
    [appendChunk],
  );

  useInput((input, key) => {
    if (step === 'menu') {
      if (input === 'p') run('plan');
      else if (input === 'i' && isLinux) run('install');
      else if (key.escape || input === 'q' || input === 'b') onBack();
      return;
    }
    if (step === 'running') {
      // 'c' cancels the child; the close handler moves us to 'done'.
      if (input === 'c') childRef.current?.kill('SIGTERM');
      return;
    }
    if (input === 'b') {
      setStep('menu');
      setLines([]);
      setExitCode(null);
      return;
    }
    if (key.escape || input === 'q' || key.return) onBack();
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const header = (
    <>
      <Text bold color="cyan">Worker Node — Install dependencies</Text>
      <Text dimColor>
        ffmpeg · native compute libraries · tesseract OCR data · Docker + compreface-core
      </Text>
    </>
  );

  if (step === 'menu') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        {header}
        <Box flexDirection="column" marginTop={1}>
          {!isLinux && (
            <Text color="yellow">
              ⚠ This installer supports Linux only (this machine is {process.platform}). See
              docs/worker-node-setup.md for manual per-platform setup — Plan still works and shows
              what a Linux host would do.
            </Text>
          )}
          {isLinux && sudoOk === false && (
            <Text color="yellow">
              ⚠ sudo would prompt for a password, and the installer runs without a terminal here.
              Run `sudo -v` in another shell first (or use `memoriahub node install-deps` directly),
              otherwise privileged steps will fail.
            </Text>
          )}
          {isLinux && sudoOk === true && (
            <Text dimColor>sudo is available without a prompt — privileged steps can run.</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            [p] plan (dry run — changes nothing)   {isLinux ? '[i] install   ' : ''}[Esc/q] back
          </Text>
        </Box>
      </Box>
    );
  }

  const title = mode === 'plan' ? 'Plan (dry run)' : 'Install';
  const ok = exitCode === 0;

  return (
    <Box flexDirection="column" gap={1}>
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        {header}
        <Text dimColor>{title}</Text>
        {step === 'running' && (
          <Box>
            <Text color="cyan"><Spinner type="dots" /> running…</Text>
          </Box>
        )}
      </Box>

      <Box
        borderStyle={BOX_BORDER}
        borderColor={step === 'done' ? (ok ? 'cyan' : 'red') : 'cyan'}
        flexDirection="column"
        paddingX={2}
        paddingY={0}
      >
        {lines.length === 0 ? (
          <Text dimColor>(no output yet)</Text>
        ) : (
          lines.slice(-40).map((l, i) => <Text key={i}>{l}</Text>)
        )}
        {step === 'done' && (
          <Text color={ok ? 'green' : 'red'}>
            {ok ? '✔ finished (exit 0)' : `✖ finished with exit ${exitCode ?? '?'}`}
          </Text>
        )}
      </Box>

      <Box paddingX={2}>
        <Text dimColor>
          {step === 'running' ? '[c] cancel' : '[b] back to options   [Enter/Esc/q] back'}
        </Text>
      </Box>
    </Box>
  );
}
