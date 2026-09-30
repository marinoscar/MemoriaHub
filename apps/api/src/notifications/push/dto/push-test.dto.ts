import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// POST /api/admin/push-config/test — request and response (epic #481, #483)
// =============================================================================
//
// "Push doesn't work" is several failures wearing one symptom. This endpoint
// sends a real test push to the CALLER'S OWN subscriptions and reports, link by
// link, what it found. Never returned: the VAPID private key, a subscription's
// p256dh/auth, or a full endpoint (only host + last 8 chars).
// =============================================================================

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export const pushTestRequestSchema = z
  .object({
    /** THIS browser's current PushSubscription.endpoint, if it has one. */
    endpoint: z.string().url().max(2048).optional(),
    /** The applicationServerKey THIS browser subscribed with (base64url). */
    applicationServerKey: z
      .string()
      .max(200)
      .regex(BASE64URL_PATTERN, 'applicationServerKey must be base64url-encoded')
      .optional(),
  })
  .strict();
export type PushTestRequest = z.infer<typeof pushTestRequestSchema>;
export class PushTestRequestDto extends createZodDto(pushTestRequestSchema) {}

export type PushTestOverall = 'sent' | 'partial' | 'failed' | 'not_configured' | 'no_subscriptions';
export type PushTestConfigSource = 'admin' | 'none';
export type PushTestSendStatus = 'sent' | 'failed' | 'pruned' | 'skipped';

export interface PushTestConfigDiagnostics {
  /** `admin` = a `webPush` row exists; `none` = nothing configured (there is no env fallback). */
  source: PushTestConfigSource;
  enabled: boolean | null;
  active: boolean;
  publicKey: string | null;
  publicKeyValid: boolean;
  privateKeyMatchesPublicKey: boolean | null;
  subject: string | null;
  subjectValid: boolean;
  problems: string[];
}

export interface PushTestBrowserDiagnostics {
  endpointProvided: boolean;
  endpointRegistered: boolean | null;
  keyMatchesServer: boolean | null;
}

/** Per-notification-type routing diagnostics (admin policy + caller's prefs). */
export interface PushTestTypeDiagnostics {
  type: string;
  mandatory: boolean;
  policyAllows: boolean;
  preferenceAllows: boolean;
}

export interface PushTestSendResult {
  status: PushTestSendStatus;
  statusCode: number | null;
  message: string | null;
  responseBody: string | null;
  durationMs: number;
}

export interface PushTestSubscriptionResult {
  id: string;
  pushService: string;
  endpointPreview: string;
  isThisBrowser: boolean;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
  result: PushTestSendResult;
}

export interface PushTestResponse {
  ranAt: string;
  durationMs: number;
  overall: PushTestOverall;
  testId: string;
  config: PushTestConfigDiagnostics;
  browser: PushTestBrowserDiagnostics;
  /** Routing per notification type; empty until the channel layer lands (#484). */
  types: PushTestTypeDiagnostics[];
  subscriptions: PushTestSubscriptionResult[];
  hints: string[];
}

type SecretFieldNames =
  | 'privateKey'
  | 'privateKeyEncrypted'
  | 'secret'
  | 'ciphertext'
  | 'p256dh'
  | 'auth'
  | 'keys'
  | 'endpoint';
type NoSecretIn<T> = Extract<keyof T, SecretFieldNames> extends never ? true : never;

/** Compile-time proof no response shape grew a secret-bearing field. */
export type PushTestResponseCarriesNoSecret = NoSecretIn<PushTestResponse> &
  NoSecretIn<PushTestConfigDiagnostics> &
  NoSecretIn<PushTestBrowserDiagnostics> &
  NoSecretIn<PushTestSubscriptionResult> &
  NoSecretIn<PushTestSendResult>;
export const PUSH_TEST_RESPONSE_CARRIES_NO_SECRET: PushTestResponseCarriesNoSecret = true;
