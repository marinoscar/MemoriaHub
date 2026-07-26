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
 *   'form'       — wizard over: name, concurrency, a CompreFace base-URL text
 *                  field (CompreFace is the only supported face-detection
 *                  provider — Human and AWS Rekognition were removed, issue
 *                  #113 — so there is no provider field to toggle), and
 *                  eligible types (comma-separated). Tab/↓ moves focus
 *                  forward, ↑ moves back; Enter on scalar fields advances
 *                  focus, Enter on the last field (types) submits.
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

type FaceProvider = 'compreface';

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

/** Job types whose required capabilities are all satisfied by `caps` — mirrors
 *  the private `supportedTypes()` helper in commands/node.ts. `faceProvider`
 *  is retained as a parameter (always 'compreface', the only supported
 *  value) for parity with that helper's signature. */
function supportedTypes(
  caps: Record<string, CapabilityStatus>,
  faceProvider: FaceProvider = 'compreface',
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
type Field = 'name' | 'concurrency' | 'comprefaceUrl' | 'types';

/** Fixed field order — CompreFace is the only face provider, so its URL
 *  field is always a stop on the tour (no provider toggle to gate it on). */
const FIELD_ORDER: Field[] = ['name', 'concurrency', 'comprefaceUrl', 'types'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeRegister({ config, onRegistered, onBack }: NodeRegisterProps): React.ReactElement {
  const [step, setStep] = useState<Step>(config.nodeId ? 'confirm' : 'detecting');

  const [name, setName] = useState<string>('');
  const [concurrencyStr, setConcurrencyStr] = useState<string>(String(DEFAULT_CONCURRENCY));
  /** Always 'compreface' — the only supported face-detection provider. */
  const faceProvider: FaceProvider = 'compreface';
  const [comprefaceUrl, setComprefaceUrl] = useState<string>(
    config.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL,
  );
  const [typesStr, setTypesStr] = useState<string>('');
  const [field, setField] = useState<Field>('name');
  const [fieldError, setFieldError] = useState<string>('');

  // Capability snapshot from the last detection run, kept around for parity
  // with commands/node.ts's helper shape (unused for re-evaluation now that
  // there's no provider toggle, but harmless to retain).
  const [caps, setCaps] = useState<Record<string, CapabilityStatus> | null>(null);
  // True once the user has manually edited the Types field in this session.
  const typesTouchedRef = useRef(false);

  const [result, setResult] = useState<NodeRegisterResult | null>(null);
  const [registeredTypes, setRegisteredTypes] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>('');

  // ---- capability auto-detection on mount (also runs after a 'confirm' yes) ----
  const runDetection = useCallback((): void => {
    setStep('detecting');
    void detectCapabilities().then((detected) => {
      setName(os.hostname());
      setConcurrencyStr(String(config.node?.concurrency ?? DEFAULT_CONCURRENCY));
      setComprefaceUrl(config.node?.comprefaceUrl ?? DEFAULT_COMPREFACE_URL);
      setCaps(detected);
      typesTouchedRef.current = false;
      setTypesStr(
        config.node?.eligibleTypes && config.node.eligibleTypes.length > 0
          ? config.node.eligibleTypes.join(', ')
          : supportedTypes(detected, faceProvider).join(', '),
      );
      setField('name');
      setStep('form');
    });
  }, [config.node]);

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
          comprefaceUrl: comprefaceUrl.trim() || DEFAULT_COMPREFACE_URL,
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
      setField('comprefaceUrl');
      return;
    }
    if (field === 'comprefaceUrl') {
      const trimmed = comprefaceUrl.trim();
      if (!trimmed) {
        setFieldError('CompreFace URL is required.');
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
  }, [field, concurrencyStr, comprefaceUrl, typesStr, submit]);

  // ---- confirm step keys ----
  useInput((input, key) => {
    if (step !== 'confirm') return;
    if (input === 'y') {
      runDetection();
    } else if (input === 'n' || key.escape || input === 'q') {
      onBack();
    }
  });

  // ---- form step: Tab/arrows move focus; typing goes to the focused
  // TextInput (which owns its own Enter-to-advance via onSubmit) ----
  useInput((input, key) => {
    if (step !== 'form') return;
    if (key.escape || input === 'q') {
      onBack();
      return;
    }
    if (key.tab || key.downArrow) {
      setFieldError('');
      setField((f) => FIELD_ORDER[(FIELD_ORDER.indexOf(f) + 1) % FIELD_ORDER.length]);
      return;
    }
    if (key.upArrow) {
      setFieldError('');
      setField(
        (f) => FIELD_ORDER[(FIELD_ORDER.indexOf(f) - 1 + FIELD_ORDER.length) % FIELD_ORDER.length],
      );
      return;
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
        <Text dimColor>{' '}</Text>
        <Text dimColor>{'Face provider'.padEnd(12)}</Text>
        <Text dimColor>compreface (fixed — the only supported provider)</Text>
      </Box>

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
        <Text dimColor>[Tab/↑/↓] move field  [Enter] next / submit on last field  [Esc/q] cancel</Text>
      </Box>
    </Box>
  );
}
