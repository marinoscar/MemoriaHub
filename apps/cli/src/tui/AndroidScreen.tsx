/**
 * tui/AndroidScreen.tsx — "Android app (build, publish, releases)" (issue #517).
 *
 * A status panel (Checkout, Local version, Keystore, Login/server, Server
 * release, Newer?) over an action list: doctor (plan, then fix), bump, build,
 * publish, RELEASE (highlighted by default), releases (with rollback), login.
 *
 * Every long-running step SPAWNS THIS SAME CLI (`memoriahub android …`) as a
 * child with piped output, rendered as Ink <Text> lines — the pattern of
 * NodeInstallDeps.tsx. Ink owns stdout/stdin, so `stdio: 'inherit'` is never
 * used, and the child never gets a terminal: every confirmation happens HERE
 * (defaulting to No) and the child is run with `--yes` where it would ask.
 * The CLI command is therefore the single implementation; this screen only
 * decides what to run (tui/android-model.ts) and renders it.
 *
 * Only cheap, silent work runs in-process: reading the status, bumping
 * version.properties, and listing releases.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../android/errors.js';
import { findRepoRoot, versionPropertiesPath } from '../android/paths.js';
import { apiClientFor, listReleases, storedCredentials, type AndroidRelease } from '../android/publish.js';
import { getReleaseStatus, type ReleaseStatus } from '../android/release-status.js';
import { BUMP_PARTS, bumpVersionFile, previewBump, versionLabel, type BumpPart } from '../android/version.js';
import {
  INITIAL_STATE,
  actionItems,
  bumpLabel,
  defaultActionIndex,
  itemLabel,
  reduce,
  releaseLabel,
  statusRows,
  type ActionItem,
  type Confirmation,
  type ModelContext,
  type ScreenEvent,
  type ScreenState,
} from './android-model.js';
import { BOX_BORDER } from './theme.js';

export interface AndroidScreenProps {
  onBack: () => void;
  /** Open the login screen; it returns to this screen. */
  onLogin: () => void;
}

/** Output lines kept for a running task; a Gradle build prints thousands. */
const MAX_LINES = 400;

/** argv re-invoking this same CLI's `android …`. */
export function androidArgv(args: readonly string[]): { cmd: string; args: string[] } {
  const entry = path.resolve(process.argv[1] ?? '');
  return { cmd: process.execPath, args: [entry, 'android', ...args] };
}

function Frame({ title, hints, children }: { title: string; hints: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Text bold color="cyan">{title}</Text>
        {children}
      </Box>
      <Box paddingX={2}>
        <Text dimColor>{hints}</Text>
      </Box>
    </Box>
  );
}

export function AndroidScreen({ onBack, onLogin }: AndroidScreenProps): React.ReactElement {
  const mounted = useRef(true);
  const childRef = useRef<ReturnType<typeof spawn> | null>(null);
  useEffect(
    () => () => {
      mounted.current = false;
      childRef.current?.kill('SIGTERM');
    },
    [],
  );

  const [repoRoot] = useState<string | undefined>(() => findRepoRoot());
  const [status, setStatus] = useState<ReleaseStatus | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<ScreenState>(INITIAL_STATE);
  const [lines, setLines] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setStatusError(undefined);
    void getReleaseStatus(repoRoot)
      .then((result) => {
        if (mounted.current) setStatus(result);
      })
      .catch((error: unknown) => {
        if (mounted.current) setStatusError(errorMessage(error));
      });
  }, [repoRoot, refresh]);

  const ctx: ModelContext = {
    status,
    repoRoot,
    preview: (part) => previewBump(versionPropertiesPath(repoRoot ?? '.'), part),
  };
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const send = useCallback((event: ScreenEvent) => setState((current) => reduce(current, event, ctxRef.current)), []);

  const appendChunk = useCallback((chunk: string) => {
    if (!mounted.current) return;
    setLines((current) => {
      const next = [...current, ...chunk.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0)];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  // Start the child when a task phase begins.
  const phase = state.phase;
  const taskKey = phase.kind === 'task' && phase.running ? phase.task.args.join('\u0000') : undefined;
  useEffect(() => {
    if (phase.kind !== 'task' || !phase.running || childRef.current !== null) return;
    setLines([]);
    const { cmd, args } = androidArgv(phase.task.args);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    } catch (error) {
      appendChunk(`Could not start the CLI: ${errorMessage(error)}`);
      send({ type: 'task-done', exitCode: 1 });
      return;
    }
    childRef.current = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => appendChunk(c));
    child.stderr?.on('data', (c: string) => appendChunk(c));
    child.on('error', (error) => appendChunk(`Error: ${error.message}`));
    child.on('close', (code) => {
      childRef.current = null;
      if (mounted.current) send({ type: 'task-done', exitCode: code ?? 1 });
    });
  }, [taskKey]);

  const backToMenu = useCallback(() => {
    send({ type: 'back' });
    setRefresh((value) => value + 1);
  }, [send]);

  useInput((input, key) => {
    switch (phase.kind) {
      case 'menu':
        if (key.escape || input === 'q') onBack();
        else if (input === 'r') {
          setStatus(undefined);
          setRefresh((value) => value + 1);
        }
        return;
      case 'task':
        if (phase.running) {
          if (input === 'c') childRef.current?.kill('SIGTERM');
          return;
        }
        if (key.escape || key.return || input === 'q') backToMenu();
        return;
      case 'releases':
        return; // ReleasesView binds its own keys
      default:
        if (key.escape) send({ type: 'back' });
    }
  });

  // ---- render ---------------------------------------------------------------------
  if (phase.kind === 'releases') {
    return (
      <ReleasesView
        serverUrl={status?.login.serverUrl ?? ''}
        notice={state.notice?.text}
        onBack={() => send({ type: 'back' })}
        onSelect={(target, releases) => send({ type: 'make-current', target, releases })}
      />
    );
  }

  if (phase.kind === 'confirm') {
    return <ConfirmView confirmation={phase.confirmation} onAnswer={(yes) => send({ type: 'confirm', yes })} />;
  }

  if (phase.kind === 'task') {
    const ok = phase.exitCode === 0;
    return (
      <Frame
        title={`Android — ${phase.task.title}${phase.running ? '' : ok ? ' — done' : ' — FAILED'}`}
        hints={phase.running ? '[c] cancel' : '[Enter/Esc] back'}
      >
        <Text dimColor>{`$ memoriahub android ${phase.task.args.join(' ')}`}</Text>
        {phase.running ? (
          <Text color="cyan">
            <Spinner type="dots" /> running…
          </Text>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {lines.length === 0 ? <Text dimColor>(no output yet)</Text> : lines.slice(-30).map((l, i) => <Text key={i}>{l}</Text>)}
        </Box>
        {phase.running ? null : (
          <Text color={ok ? 'green' : 'red'}>{ok ? '✔ finished (exit 0)' : `✖ finished with exit ${phase.exitCode ?? '?'}`}</Text>
        )}
      </Frame>
    );
  }

  if (phase.kind === 'doctor-mode') {
    return (
      <Frame title="Android — Doctor" hints="↑↓ move · enter choose · esc back">
        <Text>The plan is printed first and changes nothing; the fix installs the JDK (apt) and the Android SDK.</Text>
        <SelectInput
          items={[
            { key: 'plan', label: 'Check and show the fix plan (dry run)', value: 'plan' as const },
            { key: 'fix', label: 'Fix — install what is missing…', value: 'fix' as const },
          ]}
          onSelect={(item) => send({ type: 'doctor-mode', mode: item.value })}
        />
      </Frame>
    );
  }

  if (phase.kind === 'part' && repoRoot !== undefined) {
    const file = versionPropertiesPath(repoRoot);
    const forRelease = phase.for === 'release';
    const items: Array<{ key: string; label: string; value: BumpPart | 'none' }> = BUMP_PARTS.map((part) => ({
      key: part,
      label: bumpLabel(part, previewBump(file, part)),
      value: part,
    }));
    if (forRelease) items.push({ key: 'none', label: 'none   release the current version as it is', value: 'none' });
    return (
      <Frame title={forRelease ? 'Android — Release: bump?' : 'Android — Bump version'} hints="↑↓ move · enter choose · esc back">
        <Text>
          {forRelease
            ? 'Which part of the version does this release bump?'
            : 'Writes apps/android/version.properties (name, and code + 1). Nothing is committed.'}
        </Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (forRelease) {
              send({ type: 'part', part: item.value === 'none' ? undefined : item.value });
              return;
            }
            try {
              const bump = bumpVersionFile(file, item.value as BumpPart);
              send({ type: 'notice', text: `Bumped ${versionLabel(bump.before)} → ${versionLabel(bump.after)}.`, color: 'green' });
            } catch (error) {
              send({ type: 'notice', text: errorMessage(error), color: 'red' });
            }
            send({ type: 'part', part: item.value as BumpPart });
            setRefresh((value) => value + 1);
          }}
        />
      </Frame>
    );
  }

  if (phase.kind === 'notes') {
    return (
      <Frame title={`Android — ${phase.for === 'publish' ? 'Publish' : 'Release'}`} hints="enter continue · esc back">
        <Text>Release notes (optional, shown on the download page):</Text>
        <Box>
          <Text color="cyan">› </Text>
          <TextInput
            value={notes}
            onChange={setNotes}
            onSubmit={(value) => {
              send({ type: 'notes', text: value });
              setNotes('');
            }}
          />
        </Box>
      </Frame>
    );
  }

  // ---- the menu ---------------------------------------------------------------------
  const items = actionItems(status);
  return (
    <Frame title="Android app (build, publish, releases)" hints="↑↓ move · enter select · r refresh · esc back">
      <Box flexDirection="column">
        {statusError !== undefined ? <Text color="red">{statusError} (press r to retry)</Text> : null}
        {status === undefined && statusError === undefined ? (
          <Text>
            <Spinner type="dots" /> Reading the release status…
          </Text>
        ) : null}
        {status === undefined
          ? null
          : statusRows(status).map((row) => (
              <Text key={row.label}>
                <Text dimColor>{row.label.padEnd(15)}</Text>
                {row.color === undefined ? <Text>{row.value}</Text> : <Text color={row.color}>{row.value}</Text>}
              </Text>
            ))}
      </Box>
      {state.notice === undefined ? null : (
        <Box marginTop={1}>
          <Text color={state.notice.color}>{state.notice.text}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <SelectInput
          key={status === undefined ? 'loading' : 'ready'}
          items={items.map((item) => ({ key: item.action, label: itemLabel(item), value: item }))}
          initialIndex={defaultActionIndex(items)}
          onSelect={(entry: { value: ActionItem }) => {
            if (entry.value.enabled && entry.value.action === 'login') {
              onLogin();
              return;
            }
            send({ type: 'select', item: entry.value });
          }}
        />
      </Box>
    </Frame>
  );
}

// -----------------------------------------------------------------------------
// Confirmation: "No" first and highlighted.
// -----------------------------------------------------------------------------

function ConfirmView({ confirmation, onAnswer }: { confirmation: Confirmation; onAnswer: (yes: boolean) => void }): React.ReactElement {
  return (
    <Frame title={`Confirm — ${confirmation.title}`} hints="enter select · esc back">
      <Text bold>{confirmation.question}</Text>
      <Box flexDirection="column">
        {confirmation.lines.map((line) => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
      </Box>
      {confirmation.warning === undefined ? null : <Text color="yellow">⚠ {confirmation.warning}</Text>}
      <SelectInput
        items={[
          { key: 'no', label: 'No, go back', value: false },
          { key: 'yes', label: confirmation.yes, value: true },
        ]}
        onSelect={(item) => onAnswer(item.value)}
      />
    </Frame>
  );
}

// -----------------------------------------------------------------------------
// Releases: list; selecting one offers make-current (rollback).
// -----------------------------------------------------------------------------

function ReleasesView({
  serverUrl,
  notice,
  onBack,
  onSelect,
}: {
  serverUrl: string;
  notice: string | undefined;
  onBack: () => void;
  onSelect: (target: AndroidRelease, releases: AndroidRelease[]) => void;
}): React.ReactElement {
  const [releases, setReleases] = useState<AndroidRelease[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [run, setRun] = useState(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    setReleases(undefined);
    setError(undefined);
    const credentials = storedCredentials();
    if (credentials === undefined) {
      setError('Not logged in.');
      return;
    }
    void listReleases(apiClientFor(credentials, { quick: true }))
      .then((list) => {
        if (mounted.current) setReleases(list);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(errorMessage(cause));
      });
  }, [run]);

  useInput((input, key) => {
    if (key.escape || input === 'q') onBack();
    if (input === 'r') setRun((value) => value + 1);
  });

  return (
    <Frame title={`Android — Releases on ${serverUrl}`} hints="↑↓ move · enter make current · r refresh · esc back">
      {error !== undefined ? <Text color="red">{error} (press r to retry)</Text> : null}
      {releases === undefined && error === undefined ? (
        <Text>
          <Spinner type="dots" /> Loading releases…
        </Text>
      ) : null}
      {releases !== undefined && releases.length === 0 ? <Text>No releases have been published yet.</Text> : null}
      {notice === undefined ? null : <Text color="yellow">{notice}</Text>}
      {releases !== undefined && releases.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>* = current release</Text>
          <SelectInput
            items={releases.map((release) => ({ key: release.id, label: releaseLabel(release), value: release }))}
            onSelect={(item) => onSelect(item.value, releases)}
          />
        </Box>
      ) : null}
    </Frame>
  );
}
