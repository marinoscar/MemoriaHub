/**
 * The runtime-configurable Web Push (VAPID) admin API, as the web app sees it.
 *
 * Epic #481, issue #487 — the web half of `/api/admin/push-config`
 * (`apps/api/src/notifications/push/push-config.controller.ts`). `services/api.ts`
 * stays the transport; this module holds the six calls next to the types they
 * produce, mirroring the API's `dto/push-config.dto.ts` and `dto/push-test.dto.ts`
 * field for field.
 *
 * THE PRIVATE KEY IS NEVER ON THE WIRE, IN EITHER DIRECTION. No endpoint below
 * returns key material beyond `privateKeyStatus` (`configured`, `last4`,
 * `updatedAt`), and nothing in this module may grow a field that could hold it.
 *
 * TWO CONFIRMATION LITERALS, DELIBERATELY DIFFERENT WORDS. `ROTATE` and `REMOVE`
 * are Zod literals on the API's DTOs (the same pattern as the database
 * restore's `RESTORE`/`ROLLBACK`), so a confirmation typed for one destructive
 * action can never satisfy the other.
 */

import { api } from './api';

/** What the UI may know about the stored private key — never the key itself. */
export interface PushPrivateKeyStatus {
  configured: boolean;
  /** Last four characters of the stored key, for identification only. */
  last4: string | null;
  updatedAt: string | null;
}

/** `GET /api/admin/push-config`, and the body every write returns. */
export interface PushConfigAdminView {
  enabled: boolean;
  /** Not secret: it is what `pushManager.subscribe()` is given. Rendered in full. */
  publicKey: string | null;
  /** The stored subject; `null` means the generic fallback is in use. */
  subject: string | null;
  /** The subject actually signed with (`subject ?? default`). */
  effectiveSubject: string;
  /** Both halves of the key pair are present. */
  configured: boolean;
  /** `enabled && configured` — push can be sent right now. */
  active: boolean;
  privateKeyStatus: PushPrivateKeyStatus;
  /** Field paths of a stored row that failed validation, else `null`. */
  settingsError: string | null;
  updatedAt: string | null;
  /** The id of the user who last wrote the row — a plain string, never an object. */
  updatedById: string | null;
}

/** `PUT` — partial update; keys are retained either way. `subject: null` clears it. */
export interface UpdatePushConfigInput {
  enabled?: boolean;
  subject?: string | null;
}

/** `POST /generate` and `/rotate` both accept an optional subject. */
export interface PushConfigSubjectInput {
  subject?: string | null;
}

export const ROTATE_CONFIRMATION = 'ROTATE';
export const REMOVE_CONFIRMATION = 'REMOVE';

const BASE = '/admin/push-config';

/** `GET` — `push:read`. */
export function getPushConfig(): Promise<PushConfigAdminView> {
  return api.get<PushConfigAdminView>(BASE);
}

/** `PUT` — `push:write`. `409` when enabling with no key pair generated yet. */
export function updatePushConfig(input: UpdatePushConfigInput): Promise<PushConfigAdminView> {
  return api.put<PushConfigAdminView>(BASE, input);
}

/** `POST /generate` — `push:write`. First-time setup only: `409` if keys exist. */
export function generatePushConfig(
  input: PushConfigSubjectInput = {},
): Promise<PushConfigAdminView> {
  return api.post<PushConfigAdminView>(`${BASE}/generate`, input);
}

/**
 * `POST /rotate` — `push:write`, DESTRUCTIVE: every existing subscription stops
 * receiving pushes until its browser re-subscribes against the new key.
 */
export function rotatePushConfig(
  input: PushConfigSubjectInput = {},
): Promise<PushConfigAdminView> {
  return api.post<PushConfigAdminView>(`${BASE}/rotate`, {
    confirmation: ROTATE_CONFIRMATION,
    ...input,
  });
}

/** `DELETE` — `push:write`, DESTRUCTIVE: deletes the key pair entirely. */
export function removePushConfig(): Promise<PushConfigAdminView> {
  return api.delete<PushConfigAdminView>(BASE, {
    body: JSON.stringify({ confirmation: REMOVE_CONFIRMATION }),
  });
}

// =============================================================================
// Test & diagnostics — POST /api/admin/push-config/test
// =============================================================================

export interface PushTestInput {
  /** THIS browser's current `PushSubscription.endpoint`, so the server can flag it. */
  endpoint?: string;
  /** base64url of the key THIS browser subscribed with. */
  applicationServerKey?: string;
}

export type PushTestOverall = 'sent' | 'partial' | 'failed' | 'not_configured' | 'no_subscriptions';
export type PushTestSendStatus = 'sent' | 'failed' | 'pruned' | 'skipped';

export interface PushTestConfigDiagnostics {
  /** `admin` = a stored row exists; `none` = nothing configured (no env fallback). */
  source: 'admin' | 'none';
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

/** Push routing per notification type: the admin policy and the caller's own preference. */
export interface PushTestTypeDiagnostics {
  type: string;
  mandatory: boolean;
  policyAllows: boolean;
  preferenceAllows: boolean;
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
  result: {
    status: PushTestSendStatus;
    statusCode: number | null;
    message: string | null;
    responseBody: string | null;
    durationMs: number;
  };
}

export interface PushTestResult {
  ranAt: string;
  durationMs: number;
  overall: PushTestOverall;
  /** Also the `id` of the push payload the service worker acks. */
  testId: string;
  config: PushTestConfigDiagnostics;
  browser: PushTestBrowserDiagnostics;
  types: PushTestTypeDiagnostics[];
  subscriptions: PushTestSubscriptionResult[];
  hints: string[];
}

/** `POST /test` — `push:write`. Always 200: a failed send IS the diagnostic. */
export function sendPushTest(input: PushTestInput = {}): Promise<PushTestResult> {
  return api.post<PushTestResult>(`${BASE}/test`, input);
}
