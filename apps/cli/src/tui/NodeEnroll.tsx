/**
 * tui/NodeEnroll.tsx — Ink screen for `memoriahub node enroll`.
 *
 * Enrollment is the FIRST step of worker-node onboarding: it logs in via the
 * device flow and mints a durable, least-privilege `nod_` node credential
 * (POST /api/node-credentials), storing that as the CLI's token instead of a
 * soon-to-expire personal access token. Until now it existed only as a
 * headless command, so a menu user hit `Register node` with no usable
 * credential and no signposting (issue #413).
 *
 * The credential-minting core is NOT reimplemented here: this screen drives
 * `enrollNode()` from node/enroll.ts — the same UI-free, dependency-injected
 * function `enrollCmd()` in commands/node.ts calls — and injects an in-Ink
 * `deviceLogin` built from the same requestDeviceCode/pollForDeviceToken pair
 * LoginScreen.tsx uses. There is no shelling out and no `stdio: 'inherit'`
 * child, so nothing races Ink's render loop.
 *
 * Step machine (mirrors LoginScreen.tsx):
 *   url       → confirm/enter server URL + credential label
 *   requesting→ POST /api/auth/device/code (spinner)
 *   device    → show userCode + verificationUri; poll for the session token
 *   minting   → enrollNode(): mint the node credential + persist config
 *   success   → show the credential prefix; Enter/Esc → onDone
 *   error     → message; Enter/r retries from the url step
 *
 * Async-after-unmount guard: a `cancelled` ref mirrors LoginScreen's — every
 * async callback checks it before touching state.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import * as os from 'node:os';

import { ApiClient } from '../api.js';
import { saveConfig, type CliConfig } from '../config.js';
import {
  requestDeviceCode,
  pollForDeviceToken,
  type DeviceTokenResult,
} from '../device-auth.js';
import {
  enrollNode,
  defaultNodeCredentialName,
  NodeEnrollmentUnsupportedError,
} from '../node/enroll.js';
import { openBrowser } from '../open-browser.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props + local types
// ---------------------------------------------------------------------------

export interface NodeEnrollProps {
  config: CliConfig | null;
  /** Called with the persisted config once a node credential has been minted. */
  onEnrolled: (cfg: CliConfig) => void;
  onBack: () => void;
}

type Step = 'form' | 'requesting' | 'device' | 'minting' | 'success' | 'error';
type FormFocus = 'server' | 'name';

interface DeviceInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeEnroll({ config, onEnrolled, onBack }: NodeEnrollProps): React.ReactElement {
  const [step, setStep] = useState<Step>('form');
  const [serverUrl, setServerUrl] = useState<string>(config?.serverUrl ?? '');
  const [credName, setCredName] = useState<string>(defaultNodeCredentialName());
  const [focus, setFocus] = useState<FormFocus>('server');
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [spinnerText, setSpinnerText] = useState('Waiting for authorization in browser…');
  const [errorMsg, setErrorMsg] = useState('');
  const [minted, setMinted] = useState<{ name: string; tokenPrefix: string; expiresAt: string | null } | null>(null);

  const cancelledRef = useRef(false);
  const pendingTokenRef = useRef<DeviceTokenResult | null>(null);
  // enrollNode() builds the next config internally and hands it to saveConfigFn;
  // capturing it there is what lets this screen report the REAL persisted config
  // (new `nod_` token, dropped patExpiresAt) back to app.tsx.
  const persistedCfgRef = useRef<CliConfig | null>(null);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  useInput((input, key) => {
    if (step === 'form') {
      if (key.escape) {
        cancelledRef.current = true;
        onBack();
        return;
      }
      if (key.tab) setFocus((f) => (f === 'server' ? 'name' : 'server'));
      return;
    }
    if (step === 'success') {
      if (key.return || key.escape || input === 'q') {
        const cfg = persistedCfgRef.current;
        if (cfg) onEnrolled(cfg);
        else onBack();
      }
      return;
    }
    if (step === 'error') {
      if (key.return || input === 'r') {
        cancelledRef.current = false;
        setErrorMsg('');
        setDeviceInfo(null);
        setStep('form');
        setFocus('server');
        return;
      }
      if (key.escape || input === 'q') onBack();
      return;
    }
    // in-flight steps: Esc cancels
    if (key.escape) {
      cancelledRef.current = true;
      onBack();
    }
  });

  function submitForm(): void {
    const url = serverUrl.trim();
    if (!url) {
      setErrorMsg('Server URL cannot be empty.');
      setStep('error');
      return;
    }
    if (!credName.trim()) {
      setCredName(defaultNodeCredentialName());
    }
    setServerUrl(url);
    setStep('requesting');
  }

  // -------------------------------------------------------------------------
  // requesting → device code
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 'requesting') return;
    const normalised = serverUrl.replace(/\/$/, '');
    void (async () => {
      try {
        const resp = await requestDeviceCode(normalised, {
          tokenType: 'pat',
          name: 'MemoriaHub Node Enrollment',
          hostname: os.hostname(),
          platform: os.platform(),
        });
        if (cancelledRef.current) return;
        setDeviceInfo({
          userCode: resp.userCode,
          verificationUri: resp.verificationUri,
          verificationUriComplete: resp.verificationUriComplete,
          deviceCode: resp.deviceCode,
          interval: resp.interval,
          expiresIn: resp.expiresIn,
        });
        setStep('device');
      } catch (err) {
        if (cancelledRef.current) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // -------------------------------------------------------------------------
  // device → poll for the session token
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 'device' || !deviceInfo) return;
    openBrowser(deviceInfo.verificationUriComplete);
    const normalised = serverUrl.replace(/\/$/, '');
    void (async () => {
      try {
        const token = await pollForDeviceToken(
          normalised,
          deviceInfo.deviceCode,
          deviceInfo.interval,
          deviceInfo.expiresIn,
          (state) => {
            if (cancelledRef.current) return;
            if (state === 'slow_down') {
              setSpinnerText('Waiting for authorization… (server asked to slow down)');
            }
          },
        );
        if (cancelledRef.current) return;
        pendingTokenRef.current = token;
        setStep('minting');
      } catch (err) {
        if (cancelledRef.current) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, deviceInfo]);

  // -------------------------------------------------------------------------
  // minting → enrollNode()
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 'minting') return;
    const token = pendingTokenRef.current;
    if (!token) return;
    const normalised = serverUrl.replace(/\/$/, '');
    const name = credName.trim() || defaultNodeCredentialName();

    void (async () => {
      try {
        const result = await enrollNode(
          { serverUrl: normalised, name, cfg: config },
          {
            // The device flow already ran above (in Ink), so hand its result
            // straight back rather than driving a second, headless login.
            deviceLogin: async () => token,
            makeApi: (o) => new ApiClient(o),
            saveConfigFn: (cfg) => {
              persistedCfgRef.current = cfg;
              saveConfig(cfg);
            },
          },
        );
        if (cancelledRef.current) return;
        setMinted({
          name: result.credential.name,
          tokenPrefix: result.credential.tokenPrefix,
          expiresAt: result.credential.expiresAt,
        });
        setStep('success');
      } catch (err) {
        if (cancelledRef.current) return;
        setErrorMsg(
          err instanceof NodeEnrollmentUnsupportedError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
        );
        setStep('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Worker Node — Enroll</Text>
      <Text dimColor>
        Log in and mint a durable, node-scoped credential, stored as this CLI's token.
      </Text>

      {step === 'form' && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={focus === 'server' ? 'cyan' : undefined}>{focus === 'server' ? '❯' : ' '}</Text>
            <Text color={focus === 'server' ? 'cyan' : undefined}>{'Server URL'.padEnd(16)}</Text>
            <TextInput
              value={serverUrl}
              onChange={setServerUrl}
              onSubmit={() => setFocus('name')}
              focus={focus === 'server'}
              placeholder="https://your.memoriahub.server"
            />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color={focus === 'name' ? 'cyan' : undefined}>{focus === 'name' ? '❯' : ' '}</Text>
            <Text color={focus === 'name' ? 'cyan' : undefined}>{'Credential name'.padEnd(16)}</Text>
            <TextInput
              value={credName}
              onChange={setCredName}
              onSubmit={submitForm}
              focus={focus === 'name'}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>[Tab] switch field   [Enter] continue   [Esc] back</Text>
          </Box>
        </Box>
      )}

      {step === 'requesting' && (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text dimColor>Requesting authorization code…</Text>
        </Box>
      )}

      {step === 'device' && deviceInfo && (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
            <Text dimColor>Open this URL in your browser:</Text>
            <Text color="cyan">{deviceInfo.verificationUri}</Text>
            <Text> </Text>
            <Text dimColor>Then enter the code:</Text>
            <Text bold color="yellow">{deviceInfo.userCode}</Text>
            <Text> </Text>
            <Text dimColor>Direct link: {deviceInfo.verificationUriComplete}</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text dimColor>{spinnerText}</Text>
          </Box>
          <Text dimColor>[Esc] cancel</Text>
        </Box>
      )}

      {step === 'minting' && (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text dimColor>Minting node credential…</Text>
        </Box>
      )}

      {step === 'success' && minted && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">✔ Node credential minted: {minted.name}</Text>
          <Text dimColor>  Token prefix : {minted.tokenPrefix}…</Text>
          <Text dimColor>  Expires      : {minted.expiresAt ?? 'never'}</Text>
          <Box marginTop={1}>
            <Text dimColor>Stored as this CLI's credential — Register node is the next step.</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>[Enter/Esc] back</Text>
          </Box>
        </Box>
      )}

      {step === 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">✖ {errorMsg}</Text>
          <Box marginTop={1}>
            <Text dimColor>[Enter/r] retry   [Esc/q] back</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
