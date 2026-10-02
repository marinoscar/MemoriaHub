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

/**
 * The `clientInfo` object sent with `POST /api/auth/device/code`.
 *
 * The server validates it against an explicit allowlist and STRIPS any other
 * key, so only these fields ever reach it (issue #499). Before that fix the
 * server's allowlist lacked `tokenType`/`name`, which silently turned every
 * CLI login into a 7-day session instead of a personal access token.
 */
export interface DeviceClientInfo {
  /** `'pat'` asks for a long-lived personal access token; absent means session. */
  tokenType?: 'session' | 'pat';
  /** Label shown on the activation page and used as the PAT name (max 100). */
  name?: string;
  /** Informational (max 255). */
  hostname?: string;
  /** Informational (max 50). */
  platform?: string;
  deviceName?: string;
  userAgent?: string;
  returnUri?: string;
}

/**
 * Server-side bounds on the `clientInfo` fields (see the API's
 * `ClientInfoSchema`). A value over its bound is a 400, so the CLI clamps
 * rather than letting an unusually long hostname fail the whole login.
 */
const CLIENT_INFO_LIMITS = { name: 100, hostname: 255, platform: 50 } as const;

/**
 * Build the `clientInfo` for a device login that must yield a personal access
 * token, clamped to the server's field bounds. Shared by `memoriahub login`,
 * `node enroll`, `backup` enrollment and the TUI screens so they cannot drift.
 */
export function buildPatClientInfo(
  name: string,
  hostname: string,
  platform: string,
): DeviceClientInfo {
  const clamp = (value: string, max: number) => value.trim().slice(0, max);
  return {
    tokenType: 'pat',
    name: clamp(name, CLIENT_INFO_LIMITS.name) || 'MemoriaHub CLI',
    hostname: clamp(hostname, CLIENT_INFO_LIMITS.hostname),
    platform: clamp(platform, CLIENT_INFO_LIMITS.platform),
  };
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
   * ISO 8601 timestamp when the token expires: the server's absolute
   * `expiresAt` when it sends one (PAT responses do), otherwise computed from
   * `expiresIn` (seconds from now). Undefined when the server sends neither.
   */
  expiresAt?: string;
  /**
   * `'pat'` when the server issued a personal access token. Absent means the
   * server issued a short-lived session token instead, which happens against
   * a server older than the issue #499 fix.
   */
  credentialType?: 'pat';
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
      // Success: { data: { accessToken, refreshToken, tokenType, expiresIn,
      //   credentialType?, expiresAt? } }
      const envelope = parsed as {
        data: {
          accessToken: string;
          expiresIn?: number;
          expiresAt?: string;
          credentialType?: string;
        };
      };
      if (
        typeof envelope.data !== 'object' ||
        envelope.data === null ||
        typeof envelope.data.accessToken !== 'string'
      ) {
        throw new Error('Unexpected success response shape from /api/auth/device/token');
      }
      const { accessToken, expiresIn } = envelope.data;
      // Prefer the server's absolute expiry; otherwise derive it from expiresIn.
      const serverExpiresAt =
        typeof envelope.data.expiresAt === 'string' &&
        !Number.isNaN(Date.parse(envelope.data.expiresAt))
          ? new Date(envelope.data.expiresAt).toISOString()
          : undefined;
      const expiresAt =
        serverExpiresAt ??
        (typeof expiresIn === 'number' && expiresIn > 0
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : undefined);
      const result: DeviceTokenResult = { accessToken, expiresAt };
      if (envelope.data.credentialType === 'pat') result.credentialType = 'pat';
      return result;
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
