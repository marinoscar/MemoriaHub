/**
 * tui/NodeRegister.tsx — Ink screen wrapping `memoriahub node register`.
 *
 * Reuses the exact same business logic as `registerCmd()` in
 * commands/node.ts: `detectCapabilities()` to auto-detect the default
 * eligible-type set, `api.registerNode(...)` to register server-side, and
 * `saveConfig(...)` to persist the assigned nodeId + node config locally. This
 * screen only adds an Ink form/wizard around that same sequence — no
 * registration business logic is reimplemented here.
 *
 * Steps:
 *   'detecting'  — capability auto-detection on mount (spinner)
 *   'confirm'    — only shown when `config.nodeId` is already set: registering
 *                  again REPLACES the current registration server-side and
 *                  locally, so this is a consequential action requiring a
 *                  y/n confirm (mirrors NodeDashboard's stop-daemon confirm)
 *   'form'       — wizard over: name, concurrency, face-detection provider
 *                  (human/compreface — [space] toggles, near the job-types
 *                  field since it changes which types are supported), a
 *                  CompreFace base-URL text field (only shown/focusable when
 *                  the provider is 'compreface'), and eligible types
 *                  (comma-separated). Tab/↓ moves focus forward, ↑ moves
 *                  back; Enter on scalar fields advances focus, Enter
 *                  on the last field (types) submits.
 *   'submitting' — calling the API (spinner)
 *   'success'    — assigned node ID + eligible types, CLI messaging tone
 *   'error'      — failure message; [Enter/r] retry (back to form), [Esc/q] cancel
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import * as os from 'node:os';
import { createRequire } from 'node:module';

import { ApiClient, ApiError, type NodeRegisterResult } from '../api.js';
import { saveConfig, type CliConfig, type NodeConfig } from '../config.js';
import {
  DEFAULT_COMPREFACE_URL,
  detectCapabilities,
  isNodeJobType,
  missingRequirements,
  NODE_JOB_TYPES,
  type CapabilityStatus,
} from '../node/capabilities.js';
import { BOX_BORDER } from './theme.js';

type FaceProvider = 'human' | 'compreface';

// ---------------------------------------------------------------------------
// Defaults (mirror commands/node.ts)
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 5000;
const DEFAULT_CONCURRENCY = 1;

const require = createRequire(import.meta.url);

/**
 * CLI version read from package.json at runtime — mirrors the private
 * `cliVersion()` helper in commands/node.ts (not exported, so duplicated here
 * verbatim rather than reaching across module boundaries for an 8-line
 * metadata read).
 */
function cliVersion(): string {
  try {
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Job types whose required capabilities are all satisfied by `caps` for the
 *  given face-detection provider — mirrors the private `supportedTypes()`
 *  helper in commands/node.ts, extended to thread `faceProvider` through so
 *  the default selection reflects which provider (human/compreface) the
 *  node will actually run face_detection/video_face_detection against. */
function supportedTypes(
  caps: Record<string, CapabilityStatus>,
  faceProvider: FaceProvider = 'human',
): string[] {
  return NODE_JOB_TYPES.filter((t) => missingRequirements(t, caps, faceProvider).length === 0);
}

// ---------------------------------------------------------------------------
// Props + local types
// ---------------------------------------------------------------------------

export interface NodeRegisterProps {
  config: CliConfig;
  /** Called with the newly-saved config after a successful registration. */
  onRegistered?: (config: CliConfig) => void;
  onBack: () => void;
}

type Step = 'detecting' | 'confirm' | 'form' | 'submitting' | 'success' | 'error';
type Field = 'name' | 'concurrency' | 'faceProvider' | 'comprefaceUrl' | 'types';

/**
 * Field order is dynamic: the CompreFace URL field only participates in
 * Tab/↑/↓ navigation when the face provider is 'compreface' — otherwise it
 * isn't rendered and shouldn't be a stop on the tour.
 */
function fieldOrder(faceProvider: FaceProvider): Field[] {
  return faceProvider === 'compreface'
    ? ['name', 'concurrency', 'faceProvider', 'comprefaceUrl', 'types']
    : ['name', 'concurrency', 'faceProvider', 'types'];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeRegister({ config, onRegistered, onBack }: NodeRegisterProps): React.ReactElement {
  const [step, setStep] = useState<Step>(config.nodeId ? 'confirm' : 'detecting');

  const [name, setName] = useState<string>('');
  const [concurrencyStr, setConcurrencyStr] = useState<string>(String(DEFAULT_CONCURRENCY));
  const [faceProvider, setFaceProvider] = useState<FaceProvider>(config.node?.faceProvider ?? 'human');
  const [comprefaceUrl, setComprefaceUrl] = useState<string>(
    config.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL,
  );
  const [typesStr, setTypesStr] = useState<string>('');
  const [field, setField] = useState<Field>('name');
  const [fieldError, setFieldError] = useState<string>('');

  // Capability snapshot from the last detection run, kept around so toggling
  // the face-provider field can re-evaluate the default type selection
  // without re-probing the machine.
  const [caps, setCaps] = useState<Record<string, CapabilityStatus> | null>(null);
  // True once the user has manually edited the Types field in this session —
  // once touched, a face-provider toggle no longer overwrites their edits.
  const typesTouchedRef = useRef(false);

  const [result, setResult] = useState<NodeRegisterResult | null>(null);
  const [registeredTypes, setRegisteredTypes] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>('');

  // ---- capability auto-detection on mount (also runs after a 'confirm' yes) ----
  const runDetection = useCallback((): void => {
    setStep('detecting');
    void detectCapabilities().then((detected) => {
      const initialFaceProvider = config.node?.faceProvider ?? 'human';
      setName(os.hostname());
      setConcurrencyStr(String(config.node?.concurrency ?? DEFAULT_CONCURRENCY));
      setFaceProvider(initialFaceProvider);
      setComprefaceUrl(config.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL);
      setCaps(detected);
      typesTouchedRef.current = false;
      setTypesStr(
        config.node?.eligibleTypes && config.node.eligibleTypes.length > 0
          ? config.node.eligibleTypes.join(', ')
          : supportedTypes(detected, initialFaceProvider).join(', '),
      );
      setField('name');
      setStep('form');
    });
  }, [config.node]);

  // ---- toggle the face-detection provider, re-evaluating the default type
  // selection against the new provider unless the user has already hand-
  // edited the Types field this session ----
  const toggleFaceProvider = useCallback((): void => {
    setFaceProvider((prev) => {
      const next: FaceProvider = prev === 'human' ? 'compreface' : 'human';
      if (caps && !typesTouchedRef.current) {
        setTypesStr(supportedTypes(caps, next).join(', '));
      }
      return next;
    });
  }, [caps]);

  useEffect(() => {
    if (step === 'detecting') runDetection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- submit registration — same sequence as registerCmd()'s action ----
  const submit = useCallback((): void => {
    const trimmedName = name.trim() || os.hostname();
    const concurrency = Math.max(1, parseInt(concurrencyStr, 10) || DEFAULT_CONCURRENCY);
    const requested = typesStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setStep('submitting');
    setErrorMsg('');

    const api = new ApiClient(config);
    void (async () => {
      try {
        const res = await api.registerNode({
          name: trimmedName,
          hostname: os.hostname(),
          platform: os.platform(),
          cliVersion: cliVersion(),
          eligibleTypes: requested,
          concurrency,
        });
        // faceProvider/comprefaceUrl are NODE-LOCAL config only — they are
        // never sent to the server as part of the register payload above
        // (only name/hostname/platform/cliVersion/eligibleTypes/concurrency
        // are), so they're added to the local NodeConfig only, after the
        // server call succeeds.
        const node: NodeConfig = {
          name: trimmedName,
          concurrency,
          eligibleTypes: requested,
          pollIntervalMs: config.node?.pollIntervalMs ?? DEFAULT_POLL_MS,
          faceProvider,
          comprefaceUrl: faceProvider === 'compreface' ? comprefaceUrl.trim() || DEFAULT_COMPREFACE_URL : undefined,
        };
        const newConfig: CliConfig = { ...config, nodeId: res.nodeId, node };
        saveConfig(newConfig);
        setResult(res);
        setRegisteredTypes(requested);
        setStep('success');
        onRegistered?.(newConfig);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          setErrorMsg('This command requires a token permitted to register worker nodes.');
        } else {
          setErrorMsg(`Failed to register node: ${err instanceof Error ? err.message : String(err)}`);
        }
        setStep('error');
      }
    })();
  }, [name, concurrencyStr, faceProvider, comprefaceUrl, typesStr, config, onRegistered]);

  // ---- validate + advance/submit on Enter, per field ----
  const advanceOrSubmit = useCallback((): void => {
    if (field === 'name') {
      setFieldError('');
      setField('concurrency');
      return;
    }
    if (field === 'concurrency') {
      const n = parseInt(concurrencyStr.trim(), 10);
      if (isNaN(n) || n < 1 || n > 64 || String(n) !== concurrencyStr.trim()) {
        setFieldError(`Concurrency must be an integer between 1 and 64 (got "${concurrencyStr}").`);
        return;
      }
      setFieldError('');
      setField('faceProvider');
      return;
    }
    if (field === 'faceProvider') {
      setFieldError('');
      setField(faceProvider === 'compreface' ? 'comprefaceUrl' : 'types');
      return;
    }
    if (field === 'comprefaceUrl') {
      const trimmed = comprefaceUrl.trim();
      if (!trimmed) {
        setFieldError('CompreFace URL is required when the compreface provider is selected.');
        return;
      }
      try {
        // eslint-disable-next-line no-new
        new URL(trimmed);
      } catch {
        setFieldError(`CompreFace URL must be a valid URL (got "${trimmed}").`);
        return;
      }
      setFieldError('');
      setField('types');
      return;
    }
    // types
    const requested = typesStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = requested.filter((t) => !isNodeJobType(t));
    if (invalid.length > 0) {
      setFieldError(
        `Unknown job type(s): ${invalid.join(', ')}. Valid types: ${NODE_JOB_TYPES.join(', ')}`,
      );
      return;
    }
    setFieldError('');
    submit();
  }, [field, concurrencyStr, faceProvider, comprefaceUrl, typesStr, submit]);

  // ---- confirm step keys ----
  useInput((input, key) => {
    if (step !== 'confirm') return;
    if (input === 'y') {
      runDetection();
    } else if (input === 'n' || key.escape || input === 'q') {
      onBack();
    }
  });

  // ---- form step: Tab/arrows move focus; typing goes to the focused TextInput;
  // [space] toggles the faceProvider field; [Enter] on faceProvider advances
  // (mirrors TextInput's onSubmit for the scalar fields) ----
  useInput((input, key) => {
    if (step !== 'form') return;
    if (key.escape || input === 'q') {
      onBack();
      return;
    }
    const order = fieldOrder(faceProvider);
    if (key.tab || key.downArrow) {
      setFieldError('');
      setField((f) => order[(order.indexOf(f) + 1) % order.length]);
      return;
    }
    if (key.upArrow) {
      setFieldError('');
      setField((f) => order[(order.indexOf(f) - 1 + order.length) % order.length]);
      return;
    }
    if (field === 'faceProvider') {
      if (input === ' ') {
        toggleFaceProvider();
        return;
      }
      if (key.return) {
        advanceOrSubmit();
      }
    }
  });

  // ---- error step: Enter/r retries (back to form), Esc/q cancels ----
  useInput((input, key) => {
    if (step !== 'error') return;
    if (input === 'r' || key.return) {
      setStep('form');
    } else if (key.escape || input === 'q') {
      onBack();
    }
  });

  // ---- success step: any key goes back ----
  useInput((_input, key) => {
    if (step !== 'success') return;
    if (key.escape || _input === 'q' || key.return) onBack();
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (step === 'detecting') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Register</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /> Detecting local capabilities…</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'confirm') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="yellow" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="yellow">Worker Node — Register</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">
            ⚠ This machine is already registered as{' '}
            <Text bold>{config.node?.name ?? '(unnamed)'}</Text> ({config.nodeId}).
          </Text>
          <Text color="yellow">Registering again will REPLACE the current registration.</Text>
        </Box>
        <Box marginTop={1}>
          <Text bold>Continue? [y] yes  [n] no</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'submitting') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Register</Text>
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /> Registering with the server…</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'success') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Register</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="green">
            ✔ Registered as worker node: {name} ({result?.nodeId})
          </Text>
          <Text dimColor>
            Eligible types: {registeredTypes.length > 0 ? registeredTypes.join(', ') : '(none)'}
          </Text>
          <Text dimColor>Run `memoriahub node start` (or the Worker Node dashboard) to begin processing jobs.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Enter/Esc/q] back</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'error') {
    return (
      <Box borderStyle={BOX_BORDER} borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Worker Node — Register</Text>
        <Box marginTop={1}>
          <Text color="red">✖ {errorMsg}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Enter/r] retry   [Esc/q] cancel</Text>
        </Box>
      </Box>
    );
  }

  // 'form'
  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Worker Node — Register</Text>
      <Text dimColor>Review the fields below, then submit on the last field.</Text>

      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text color={field === 'name' ? 'cyan' : undefined}>{field === 'name' ? '❯' : ' '}</Text>
        <Text color={field === 'name' ? 'cyan' : undefined}>{'Name'.padEnd(12)}</Text>
        <TextInput value={name} onChange={setName} onSubmit={advanceOrSubmit} focus={field === 'name'} />
      </Box>

      <Box flexDirection="row" gap={1}>
        <Text color={field === 'concurrency' ? 'cyan' : undefined}>{field === 'concurrency' ? '❯' : ' '}</Text>
        <Text color={field === 'concurrency' ? 'cyan' : undefined}>{'Concurrency'.padEnd(12)}</Text>
        <TextInput
          value={concurrencyStr}
          onChange={setConcurrencyStr}
          onSubmit={advanceOrSubmit}
          focus={field === 'concurrency'}
        />
      </Box>

      <Box flexDirection="row" gap={1}>
        <Text color={field === 'faceProvider' ? 'cyan' : undefined}>{field === 'faceProvider' ? '❯' : ' '}</Text>
        <Text color={field === 'faceProvider' ? 'cyan' : undefined}>{'Face provider'.padEnd(12)}</Text>
        <Text>
          <Text color={faceProvider === 'human' ? 'green' : undefined} bold={faceProvider === 'human'}>
            {faceProvider === 'human' ? '[human]' : ' human '}
          </Text>
          {'  '}
          <Text color={faceProvider === 'compreface' ? 'green' : undefined} bold={faceProvider === 'compreface'}>
            {faceProvider === 'compreface' ? '[compreface]' : ' compreface '}
          </Text>
        </Text>
      </Box>

      {faceProvider === 'compreface' ? (
        <Box flexDirection="row" gap={1}>
          <Text color={field === 'comprefaceUrl' ? 'cyan' : undefined}>{field === 'comprefaceUrl' ? '❯' : ' '}</Text>
          <Text color={field === 'comprefaceUrl' ? 'cyan' : undefined}>{'CompreFace URL'.padEnd(12)}</Text>
          <TextInput
            value={comprefaceUrl}
            onChange={setComprefaceUrl}
            onSubmit={advanceOrSubmit}
            focus={field === 'comprefaceUrl'}
          />
        </Box>
      ) : null}

      <Box flexDirection="row" gap={1}>
        <Text color={field === 'types' ? 'cyan' : undefined}>{field === 'types' ? '❯' : ' '}</Text>
        <Text color={field === 'types' ? 'cyan' : undefined}>{'Types'.padEnd(12)}</Text>
        <TextInput
          value={typesStr}
          onChange={(v) => {
            typesTouchedRef.current = true;
            setTypesStr(v);
          }}
          onSubmit={advanceOrSubmit}
          focus={field === 'types'}
        />
      </Box>

      {fieldError ? (
        <Box marginTop={1}>
          <Text color="red">✖ {fieldError}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          [Tab/↑/↓] move field  [Space] toggle provider  [Enter] next / submit on last field  [Esc/q] cancel
        </Text>
      </Box>
    </Box>
  );
}
