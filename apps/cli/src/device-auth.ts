/**
 * device-auth.ts — RFC 8628 Device Authorization Flow client
 *
 * Encapsulates the two-step device-flow protocol:
 *   1. requestDeviceCode  — POST /api/auth/device/code
 *   2. pollForDeviceToken — POST /api/auth/device/token  (polls until approved)
 *
 * Uses raw fetch (not the generic ApiClient) for the polling leg so we can
 * inspect the RFC 8628 error codes returned in the response body.
 *
 * Error JSON shape returned by the server on 400:
 *   {
 *     statusCode: 400,
 *     code: "BAD_REQUEST",
 *     message: "An unexpected error occurred",
 *     error: "authorization_pending" | "slow_down" | "expired_token" | "access_denied",
 *     error_description: string,
 *     timestamp: string,
 *     path: string
 *   }
 *
 * The 'error' field is the RFC code; the generic ApiClient would only surface
 * 'message', so we use raw fetch here to access 'error' directly.
 */

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceClientInfo {
  tokenType?: string;
  name?: string;
  hostname?: string;
  platform?: string;
  [key: string]: unknown;
}

/** Known RFC 8628 error codes returned by the token polling endpoint */
type RfcErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'
  | string;

interface ServerErrorBody {
  statusCode?: number;
  code?: string;
  message?: string;
  /** RFC 8628 error code, forwarded by the exception filter */
  error?: RfcErrorCode;
  error_description?: string;
}

/**
 * Request a device code pair from the server.
 * Returns the full response including deviceCode, userCode, verificationUri, etc.
 */
export async function requestDeviceCode(
  serverUrl: string,
  clientInfo: DeviceClientInfo,
): Promise<DeviceCodeResponse> {
  const base = serverUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/api/auth/device/code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ clientInfo }),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const body = parsed as ServerErrorBody;
    const msg = body.message || body.error_description || `HTTP ${res.status}`;
    throw new Error(`Device code request failed: ${msg}`);
  }

  // Standard envelope: { data: { deviceCode, userCode, ... } }
  const envelope = parsed as { data: DeviceCodeResponse };
  if (typeof envelope.data !== 'object' || envelope.data === null) {
    throw new Error('Unexpected response shape from /api/auth/device/code');
  }
  return envelope.data;
}

/** Successful result from polling the device token endpoint. */
export interface DeviceTokenResult {
  /** The issued access token (PAT string). */
  accessToken: string;
  /**
   * ISO 8601 timestamp when the token expires, computed from the server's
   * `expiresIn` field (seconds from now).  Undefined when the server does not
   * include an `expiresIn` value in the response.
   */
  expiresAt?: string;
}

/**
 * Poll the token endpoint until the user approves the device.
 *
 * @param serverUrl     Base server URL
 * @param deviceCode    Opaque device code from requestDeviceCode
 * @param intervalSec   Initial polling interval in seconds (server-specified)
 * @param expiresInSec  Total seconds before the device code expires
 * @param onTick        Optional callback called on each poll attempt
 * @returns The issued access token and optional expiry timestamp on success
 */
export async function pollForDeviceToken(
  serverUrl: string,
  deviceCode: string,
  intervalSec: number,
  expiresInSec: number,
  onTick?: (state: 'pending' | 'slow_down') => void,
): Promise<DeviceTokenResult> {
  const base = serverUrl.replace(/\/$/, '');
  const deadline = Date.now() + expiresInSec * 1000;
  // Add a small buffer so we don't race the server-side expiry check
  let currentInterval = Math.max(intervalSec, 1);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  while (Date.now() < deadline) {
    await sleep(currentInterval * 1000);

    const res = await fetch(`${base}/api/auth/device/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ deviceCode }),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON response is unexpected; treat as transient and keep polling
      continue;
    }

    if (res.ok) {
      // Success: { data: { accessToken, refreshToken, tokenType, expiresIn } }
      const envelope = parsed as { data: { accessToken: string; expiresIn?: number } };
      if (
        typeof envelope.data !== 'object' ||
        envelope.data === null ||
        typeof envelope.data.accessToken !== 'string'
      ) {
        throw new Error('Unexpected success response shape from /api/auth/device/token');
      }
      const { accessToken, expiresIn } = envelope.data;
      // Compute an absolute expiry timestamp when the server provides expiresIn.
      const expiresAt =
        typeof expiresIn === 'number' && expiresIn > 0
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : undefined;
      return { accessToken, expiresAt };
    }

    // Non-2xx: inspect the RFC error code
    const body = parsed as ServerErrorBody;
    const rfcCode: RfcErrorCode = body.error || '';

    switch (rfcCode) {
      case 'authorization_pending':
        onTick?.('pending');
        // Keep polling at current interval
        break;

      case 'slow_down':
        onTick?.('slow_down');
        // RFC 8628 §3.5: increase interval by at least 5 seconds
        currentInterval += 5;
        break;

      case 'expired_token':
        throw new Error(
          'The device code has expired. Please run `memoriahub login` again to start a new authorization.',
        );

      case 'access_denied':
        throw new Error(
          'Authorization was denied. The device was not approved in the browser.',
        );

      default: {
        // If the RFC 'error' field is absent (pre-fix server or unknown code),
        // fall back to treating a 400 BAD_REQUEST as authorization_pending so
        // the CLI keeps polling on older server deployments that don't yet
        // forward the RFC error field.
        if (res.status === 400 && (body.code === 'BAD_REQUEST' || !rfcCode)) {
          onTick?.('pending');
          break;
        }
        // Otherwise surface the message and abort
        const msg =
          body.message ||
          body.error_description ||
          `Unexpected error from token endpoint (HTTP ${res.status})`;
        throw new Error(msg);
      }
    }
  }

  throw new Error(
    'Device code timed out waiting for authorization. Please run `memoriahub login` again.',
  );
}
