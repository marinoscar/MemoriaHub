/**
 * tui/LoginScreen.tsx — Interactive login screen using the device authorization
 * flow (RFC 8628).
 *
 * Step machine:
 *   url        → user enters Server URL
 *   requesting → POST /api/auth/device/code (spinner)
 *   device     → show userCode + verificationUri; poll for token (spinner)
 *   validating → GET /api/auth/me; save config
 *   success    → brief confirmation, then onDone()
 *   error      → show message; Esc → onBack(), Enter/r → retry
 *
 * Async-after-unmount guard: a `cancelled` ref is set to true on Esc (or
 * unmount). Every async callback checks it before calling setState, so stray
 * resolutions from in-flight requestDeviceCode / pollForDeviceToken / fetch
 * calls are silently dropped.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import * as os from 'os';
import { ApiClient } from '../api.js';
import { saveConfig, type CliConfig } from '../config.js';
import { requestDeviceCode, pollForDeviceToken, type DeviceTokenResult } from '../device-auth.js';
import { openBrowser } from '../open-browser.js';
import { BOX_BORDER, success, error as errorColor, warning } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 'url' | 'requesting' | 'device' | 'validating' | 'success' | 'error';

interface LoginScreenProps {
  initialConfig: CliConfig | null;
  onDone: (cfg: CliConfig) => void;
  onBack: () => void;
}

interface MeResponse {
  email?: string;
  displayName?: string;
}

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

export function LoginScreen({
  initialConfig,
  onDone,
  onBack,
}: LoginScreenProps): React.ReactElement {
  const [step, setStep]             = useState<Step>('url');
  const [serverUrl, setServerUrl]   = useState(initialConfig?.serverUrl ?? '');
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [spinnerText, setSpinnerText] = useState('Waiting for authorization in browser…');
  const [errorMsg, setErrorMsg]     = useState('');
  const [identity, setIdentity]     = useState('');

  // Cancellation ref — set to true when the user presses Esc or when the
  // component unmounts. All async callbacks guard against this before touching
  // state.
  const cancelledRef = useRef(false);

  // Also cancel on unmount
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Keyboard input
  // -------------------------------------------------------------------------

  useInput((input, key) => {
    if (key.escape && step !== 'validating') {
      cancelledRef.current = true;
      onBack();
      return;
    }

    // In error state allow pressing Enter or 'r' to retry from URL step
    if (step === 'error' && (key.return || input === 'r')) {
      cancelledRef.current = false; // reset so new async ops are allowed
      setErrorMsg('');
      setDeviceInfo(null);
      setSpinnerText('Waiting for authorization in browser…');
      setStep('url');
    }
  });

  // -------------------------------------------------------------------------
  // Step: url → requesting
  // -------------------------------------------------------------------------

  function handleUrlSubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    setServerUrl(trimmed);
    setStep('requesting');
  }

  // -------------------------------------------------------------------------
  // Step: requesting — call requestDeviceCode
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 'requesting') return;

    const normalised = serverUrl.replace(/\/$/, '');

    void (async () => {
      try {
        const resp = await requestDeviceCode(normalised, {
          tokenType: 'pat',
          name: 'MemoriaHub CLI',
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
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        setStep('error');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // -------------------------------------------------------------------------
  // Step: device — open browser + poll for token
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 'device' || !deviceInfo) return;

    // Best-effort browser open
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
        // Move to validation with the token stored locally — we thread it
        // through the validate effect via a ref so we don't need another state.
        pendingTokenRef.current = token;
        setStep('validating');
      } catch (err) {
        if (cancelledRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        setStep('error');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, deviceInfo]);

  // Ref to pass the polled token into the validating effect without adding it
  // to React state (avoids an extra render cycle).
  const pendingTokenRef = useRef<DeviceTokenResult | null>(null);

  // -------------------------------------------------------------------------
  // Step: validating — GET /api/auth/me; save config
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (step !== 'validating') return;

    const tokenResult = pendingTokenRef.current;
    if (!tokenResult) return;

    const normalised = serverUrl.replace(/\/$/, '');
    const cfg: CliConfig = {
      serverUrl: normalised,
      pat: tokenResult.accessToken,
      patExpiresAt: tokenResult.expiresAt,
    };

    void (async () => {
      try {
        const api = new ApiClient(cfg);
        const me = await api.get<MeResponse>('/api/auth/me');
        if (cancelledRef.current) return;
        const email = me.email ?? 'unknown';
        saveConfig(cfg);
        setIdentity(email);
        setStep('success');
        setTimeout(() => {
          if (cancelledRef.current) return;
          onDone(cfg);
        }, 1500);
      } catch (err) {
        if (cancelledRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        setStep('error');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={3}
      paddingY={2}
    >
      <Text bold color="cyan">MemoriaHub — Login</Text>
      <Text> </Text>

      {/* Server URL row */}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Server URL:</Text>
        {step === 'url' ? (
          <TextInput
            value={serverUrl}
            onChange={setServerUrl}
            onSubmit={handleUrlSubmit}
            placeholder="https://your.memoriahub.server"
          />
        ) : (
          <Text color="cyan">{serverUrl}</Text>
        )}
      </Box>

      {/* requesting */}
      {step === 'requesting' && (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text dimColor>Requesting authorization code…</Text>
        </Box>
      )}

      {/* device — show userCode + poll spinner */}
      {step === 'device' && deviceInfo && (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Box
            borderStyle="round"
            borderColor="cyan"
            flexDirection="column"
            paddingX={2}
            paddingY={1}
          >
            <Text dimColor>Open this URL in your browser:</Text>
            <Text color="cyan">{deviceInfo.verificationUri}</Text>
            <Text> </Text>
            <Text dimColor>Then enter the code:</Text>
            <Text bold color="yellow">{deviceInfo.userCode}</Text>
            <Text> </Text>
            <Text dimColor>Direct link: {deviceInfo.verificationUriComplete}</Text>
            <Text dimColor>
              (Expires in {Math.round(deviceInfo.expiresIn / 60)} minutes)
            </Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text dimColor>{spinnerText}</Text>
          </Box>
        </Box>
      )}

      {/* validating */}
      {step === 'validating' && (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text dimColor>Verifying token…</Text>
        </Box>
      )}

      {/* success */}
      {step === 'success' && (
        <Box marginTop={1}>
          <Text color="green">{success('✔')} Logged in as {identity}</Text>
        </Box>
      )}

      {/* error */}
      {step === 'error' && (
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Text color="red">{errorColor('✖')} {errorMsg}</Text>
          <Text dimColor>
            Press <Text color="cyan">Esc</Text> to go back
            {' '}or <Text color="cyan">Enter</Text>/<Text color="cyan">r</Text> to retry.
          </Text>
        </Box>
      )}

      {/* Hints */}
      {(step === 'url') && (
        <Box marginTop={2}>
          <Text dimColor>[Esc] cancel  [Enter] confirm</Text>
        </Box>
      )}

      {/* Keep warning import used to avoid TS unused-import error */}
      {false && <Text>{warning('')}</Text>}
    </Box>
  );
}
