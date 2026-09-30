import { createECDH, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, PushSubscription } from '@prisma/client';
import * as webpush from 'web-push';
import { WebPushError } from 'web-push';

import { PrismaService } from '../../prisma/prisma.service';
import { describeThrown } from './describe-thrown';
import { DEFAULT_VAPID_SUBJECT, PUSH_CONFIG_KEY, storedPushConfigSchema } from './push-config.schema';
import { type ActiveVapidConfig, PushConfigService } from './push-config.service';
import type {
  PushTestBrowserDiagnostics,
  PushTestConfigDiagnostics,
  PushTestOverall,
  PushTestRequest,
  PushTestResponse,
  PushTestSendResult,
  PushTestSubscriptionResult,
  PushTestTypeDiagnostics,
} from './dto/push-test.dto';

// =============================================================================
// PushTestService — "send me a test push and tell me what broke" (#483)
// =============================================================================
//
// Ported from EnterpriseAppBase's PushTestService. Backs
// POST /api/admin/push-config/test and checks, separately:
//
//   1. CONFIG   — is a key pair active, is the public key a real P-256 point,
//                 does the stored private key derive it, is the subject sane?
//   2. BROWSER  — is THIS browser's endpoint registered for the caller, and was
//                 it created against the key active NOW (an unnoticed rotation
//                 is the classic silent 403)?
//   3. DELIVERY — a real signed send to each of the caller's OWN
//                 subscriptions, with the push service's status and body.
//
// NOT A QUEUE JOB: it does not outlive its request — only the caller's own
// handful of devices, in parallel, each capped by a 10 s socket timeout, and
// the admin needs the answer inline. Nothing is detached.
//
// NOT A NOTIFICATION: it writes no `notifications` or `notification_deliveries`
// row. It keeps the channel's ENDPOINT bookkeeping (success clears
// failureCount; 404/410 prunes) but deliberately does NOT increment
// failureCount on other errors — an admin clicking "test" repeatedly while
// debugging a bad key must not be able to prune their own healthy devices.
// =============================================================================

export const PUSH_TEST_TYPE = 'push_test';
const PUSH_TEST_LINK = '/admin/settings/push';
const SEND_TIMEOUT_MS = 10_000;
const TEST_TTL_SECONDS = 60;
const MAX_RESPONSE_BODY_LENGTH = 500;
const ENDPOINT_PREVIEW_TAIL = 8;
const UNCOMPRESSED_P256_POINT_LENGTH = 65;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

@Injectable()
export class PushTestService {
  private readonly logger = new Logger(PushTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushConfig: PushConfigService,
  ) {}

  /**
   * Run every check and send a test push to the caller's own subscriptions.
   * A failed SEND is the answer (HTTP 200); only an unexpected DB error 500s.
   */
  async runTest(userId: string, input: PushTestRequest): Promise<PushTestResponse> {
    const startedAt = Date.now();
    const ranAt = new Date(startedAt);
    const testId = `push-test-${randomUUID()}`;

    const [active, settingsRow, subscriptions] = await Promise.all([
      this.pushConfig.resolveActiveVapidConfig(),
      this.prisma.systemSettings.findUnique({
        where: { key: PUSH_CONFIG_KEY },
        select: { value: true },
      }),
      this.prisma.pushSubscription.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const config = this.diagnoseConfig(active, settingsRow);
    const browser = this.diagnoseBrowser(input, active, subscriptions);
    const types = await this.diagnoseTypes(userId);

    const payload = JSON.stringify({
      id: testId,
      type: PUSH_TEST_TYPE,
      title: 'Test push notification',
      body: `If you can see this, Web Push works on this device. Sent at ${ranAt.toISOString()}.`,
      link: PUSH_TEST_LINK,
      tag: testId,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      test: true,
    });

    const results: PushTestSendResult[] = active
      ? await this.sendAll(active, subscriptions, payload)
      : subscriptions.map(() => ({
          status: 'skipped' as const,
          statusCode: null,
          message: 'Not sent: Web Push is not configured or is disabled.',
          responseBody: null,
          durationMs: 0,
        }));

    const now = new Date();
    const subscriptionResults: PushTestSubscriptionResult[] = subscriptions.map((sub, i) => {
      const result = results[i];
      const sent = result.status === 'sent';
      return {
        id: sub.id,
        pushService: endpointHost(sub.endpoint),
        endpointPreview: endpointPreview(sub.endpoint),
        isThisBrowser: input.endpoint !== undefined && sub.endpoint === input.endpoint,
        userAgent: sub.userAgent,
        createdAt: sub.createdAt.toISOString(),
        lastSuccessAt: sent ? now.toISOString() : (sub.lastSuccessAt?.toISOString() ?? null),
        failureCount: sent ? 0 : sub.failureCount,
        result,
      };
    });

    const overall = computeOverall(config.active, subscriptionResults);
    const response: PushTestResponse = {
      ranAt: ranAt.toISOString(),
      durationMs: Date.now() - startedAt,
      overall,
      testId,
      config,
      browser,
      types,
      subscriptions: subscriptionResults,
      hints: [],
    };
    response.hints = buildHints(response);

    const counts = countStatuses(subscriptionResults);
    const hosts = [...new Set(subscriptionResults.map((s) => s.pushService))];
    this.logger.log(
      `Push test ${testId} by user ${userId}: ${overall} (${counts.sent} sent, ${counts.failed} failed, ` +
        `${counts.pruned} pruned, ${counts.skipped} skipped; hosts: ${hosts.join(', ') || 'none'})`,
    );
    await this.audit(userId, testId, overall, counts, hosts);

    return response;
  }

  /**
   * Per-type routing diagnostics. Overridden in behaviour once the channel
   * layer (admin policy + per-user push preferences) exists; until then there
   * is no routing to report.
   */
  protected async diagnoseTypes(_userId: string): Promise<PushTestTypeDiagnostics[]> {
    return [];
  }

  // ---------------------------------------------------------------------------
  // 1. Config
  // ---------------------------------------------------------------------------

  private diagnoseConfig(
    active: ActiveVapidConfig | null,
    settingsRow: { value: Prisma.JsonValue } | null,
  ): PushTestConfigDiagnostics {
    const problems: string[] = [];
    let enabled: boolean | null = null;
    const source = settingsRow ? 'admin' : 'none';

    if (!settingsRow) {
      problems.push('No VAPID key pair is configured. Generate one on this page.');
    } else {
      const parsed = storedPushConfigSchema.safeParse(settingsRow.value);
      if (!parsed.success) {
        problems.push('The stored Web Push configuration is invalid, so push is off.');
      } else {
        enabled = parsed.data.enabled;
        if (!parsed.data.enabled) {
          problems.push('Web Push is disabled in the admin configuration.');
        } else if (!parsed.data.publicKey || !parsed.data.privateKeyEncrypted) {
          problems.push('Web Push is enabled but its key pair is incomplete. Rotate the key pair.');
        } else if (!active) {
          problems.push(
            'Web Push is enabled but the stored private key could not be decrypted (was SECRETS_ENCRYPTION_KEY changed?). Rotate the key pair.',
          );
        }
      }
    }

    if (!active) {
      return {
        source,
        enabled,
        active: false,
        publicKey: null,
        publicKeyValid: false,
        privateKeyMatchesPublicKey: null,
        subject: null,
        subjectValid: false,
        problems,
      };
    }

    const publicKeyValid = isValidVapidPublicKey(active.publicKey);
    if (!publicKeyValid) {
      problems.push('The active VAPID public key is not a valid uncompressed P-256 key.');
    }
    const privateKeyMatchesPublicKey = privateKeyDerivesPublicKey(active.privateKey, active.publicKey);
    if (!privateKeyMatchesPublicKey) {
      problems.push('The stored VAPID private key does not match the public key. Rotate the key pair.');
    }
    const subjectValid = isValidVapidSubject(active.subject);
    if (!subjectValid) {
      problems.push(`The VAPID subject "${active.subject}" is not a mailto: address or an https:// URL.`);
    } else if (active.subject === DEFAULT_VAPID_SUBJECT) {
      problems.push(
        `No VAPID subject is configured, so the generic fallback "${DEFAULT_VAPID_SUBJECT}" is used. Set a real contact address.`,
      );
    }

    return {
      source,
      enabled,
      active: true,
      publicKey: active.publicKey,
      publicKeyValid,
      privateKeyMatchesPublicKey,
      subject: active.subject,
      subjectValid,
      problems,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Browser
  // ---------------------------------------------------------------------------

  private diagnoseBrowser(
    input: PushTestRequest,
    active: ActiveVapidConfig | null,
    subscriptions: readonly PushSubscription[],
  ): PushTestBrowserDiagnostics {
    const endpointProvided = input.endpoint !== undefined;
    return {
      endpointProvided,
      endpointRegistered: endpointProvided
        ? subscriptions.some((s) => s.endpoint === input.endpoint)
        : null,
      keyMatchesServer:
        input.applicationServerKey !== undefined && active
          ? normalizeBase64Url(input.applicationServerKey) === normalizeBase64Url(active.publicKey)
          : null,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Delivery
  // ---------------------------------------------------------------------------

  private async sendAll(
    active: ActiveVapidConfig,
    subscriptions: readonly PushSubscription[],
    payload: string,
  ): Promise<PushTestSendResult[]> {
    const vapidDetails = {
      subject: active.subject,
      publicKey: active.publicKey,
      privateKey: active.privateKey,
    };

    // Each send wrapped so a synchronous validation throw inside web-push
    // becomes that row's failure rather than a 500 for the whole test.
    const outcomes = await Promise.all(
      subscriptions.map(async (sub) => {
        const started = Date.now();
        try {
          const res = await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { vapidDetails, TTL: TEST_TTL_SECONDS, urgency: 'high', timeout: SEND_TIMEOUT_MS },
          );
          return { ok: true as const, durationMs: Date.now() - started, res };
        } catch (err) {
          return { ok: false as const, durationMs: Date.now() - started, err };
        }
      }),
    );

    return Promise.all(
      outcomes.map(async (outcome, i): Promise<PushTestSendResult> => {
        const sub = subscriptions[i];
        if (outcome.ok) {
          await this.prisma.pushSubscription
            .update({ where: { id: sub.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } })
            .catch((err) =>
              this.logger.warn(`Push test: could not record success for ${sub.id}: ${describeThrown(err)}`),
            );
          return {
            status: 'sent',
            statusCode: outcome.res?.statusCode ?? null,
            message: null,
            responseBody: null,
            durationMs: outcome.durationMs,
          };
        }

        const err = outcome.err;
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          await this.prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch((e) =>
              this.logger.warn(`Push test: could not prune dead subscription ${sub.id}: ${describeThrown(e)}`),
            );
          return { ...failedResult(err, outcome.durationMs), status: 'pruned' };
        }
        return failedResult(err, outcome.durationMs);
      }),
    );
  }

  /** Counts and hosts only — no endpoint, key or payload. Best-effort. */
  private async audit(
    userId: string,
    testId: string,
    overall: PushTestOverall,
    counts: Record<PushTestSendResult['status'], number>,
    hosts: string[],
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: 'push_config:test',
          targetType: 'system_settings',
          targetId: PUSH_CONFIG_KEY,
          meta: { testId, overall, counts, hosts } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(`Push test ${testId}: could not record the audit event: ${describeThrown(err)}`);
    }
  }
}

// =============================================================================
// Pure helpers (exported for tests)
// =============================================================================

export function normalizeBase64Url(value: string): string {
  return value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** A VAPID public key is a base64url 65-byte uncompressed P-256 point. */
export function isValidVapidPublicKey(publicKey: string): boolean {
  if (!BASE64URL_PATTERN.test(publicKey)) return false;
  const bytes = Buffer.from(normalizeBase64Url(publicKey), 'base64url');
  return bytes.length === UNCOMPRESSED_P256_POINT_LENGTH && bytes[0] === 0x04;
}

/** Does `privateKey` derive `publicKey`? `false` for anything malformed. */
export function privateKeyDerivesPublicKey(privateKey: string, publicKey: string): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(normalizeBase64Url(privateKey), 'base64url'));
    return ecdh.getPublicKey().equals(Buffer.from(normalizeBase64Url(publicKey), 'base64url'));
  } catch {
    return false;
  }
}

/** `mailto:user@host.tld`, or an `https://` URL with a host. */
export function isValidVapidSubject(subject: string): boolean {
  if (subject.startsWith('mailto:')) {
    return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject);
  }
  try {
    const url = new URL(subject);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '(invalid endpoint)';
  }
}

function endpointPreview(endpoint: string): string {
  return `${endpointHost(endpoint)}/…${endpoint.slice(-ENDPOINT_PREVIEW_TAIL)}`;
}

function failedResult(err: unknown, durationMs: number): PushTestSendResult {
  const isPushError = err instanceof WebPushError;
  return {
    status: 'failed',
    statusCode: isPushError ? err.statusCode : null,
    message: describeThrown(err),
    responseBody:
      isPushError && typeof err.body === 'string' && err.body.length > 0
        ? err.body.slice(0, MAX_RESPONSE_BODY_LENGTH)
        : null,
    durationMs,
  };
}

function countStatuses(
  subs: readonly PushTestSubscriptionResult[],
): Record<PushTestSendResult['status'], number> {
  const counts = { sent: 0, failed: 0, pruned: 0, skipped: 0 };
  for (const s of subs) counts[s.result.status]++;
  return counts;
}

function computeOverall(active: boolean, subs: readonly PushTestSubscriptionResult[]): PushTestOverall {
  if (!active) return 'not_configured';
  if (subs.length === 0) return 'no_subscriptions';
  const sent = subs.filter((s) => s.result.status === 'sent').length;
  if (sent === subs.length) return 'sent';
  if (sent > 0) return 'partial';
  return 'failed';
}

/** Plain-English next steps, ordered config → browser → delivery → routing. */
export function buildHints(result: PushTestResponse): string[] {
  const hints: string[] = [];
  const add = (hint: string) => {
    if (!hints.includes(hint)) hints.push(hint);
  };
  const { config, browser, subscriptions, types } = result;

  if (!config.active) {
    if (config.source === 'none') {
      add('Web Push is not configured. Use "Generate keys" on this page to create a VAPID key pair.');
    } else if (config.enabled === false) {
      add('Web Push is switched off. Enable it on this page, then run the test again.');
    } else {
      add('Web Push is enabled but its key pair is incomplete or unreadable. Rotate the key pair, then reload the app so browsers re-subscribe.');
    }
  } else {
    if (!config.publicKeyValid || config.privateKeyMatchesPublicKey === false) {
      add('The VAPID key pair is broken. Rotate it, then reload the app on each device so it re-subscribes.');
    }
    if (!config.subjectValid) {
      add("Set the VAPID subject to a real mailto: address or an https:// URL. Apple's push service rejects invalid subjects with 403 BadJwtToken.");
    } else if (config.subject === DEFAULT_VAPID_SUBJECT) {
      add('Set a real VAPID subject (your contact mailto: address). The generic fallback can be rejected by some push services.');
    }
  }

  if (!browser.endpointProvided) {
    add('This browser did not report a push subscription. Allow notifications for this site, then reload the page so it subscribes.');
  } else if (browser.endpointRegistered === false) {
    add('No subscription for this browser is registered on the server. Grant notification permission and reload the page so it re-subscribes.');
  }
  if (browser.keyMatchesServer === false) {
    add("This browser's subscription was created with a different VAPID key, so the push service will reject pushes to it. Reload the page so it re-subscribes with the current key.");
  }

  if (result.overall === 'no_subscriptions') {
    add('You have no push subscriptions. Open the app in a browser, allow notifications, and reload, then run the test again.');
  }

  for (const sub of subscriptions) {
    const { status, statusCode } = sub.result;
    const where = `${sub.pushService}${sub.isThisBrowser ? ' (this browser)' : ''}`;
    if (status === 'pruned') {
      add(`The subscription at ${where} has expired or been revoked (HTTP ${statusCode}) and was removed. Reload the app on that device to re-subscribe.`);
      continue;
    }
    if (status !== 'failed') continue;
    if (statusCode === 403) {
      add(`403 from ${where}: the VAPID key pair usually does not match the one the subscription was created with. Reload the app on that device so it re-subscribes.`);
    } else if (statusCode === 401) {
      add(`401 from ${where}: the push service rejected the VAPID signature. Check the subject and the key pair.`);
    } else if (statusCode === 429) {
      add(`429 from ${where}: the push service is rate-limiting this server. Wait a few minutes before testing again.`);
    } else if (statusCode !== null && statusCode >= 500) {
      add(`${statusCode} from ${where}: the push service had an error. This is usually temporary.`);
    } else if (statusCode === null) {
      add(`Could not reach ${where} (${sub.result.message ?? 'network error'}). Check that this server can make outbound HTTPS requests to the push service.`);
    } else {
      add(`${where} answered HTTP ${statusCode}. See the response body for the push service's explanation.`);
    }
  }

  if (subscriptions.some((s) => s.result.status === 'sent')) {
    add("The push service accepted the test. If nothing appeared, check the OS notification settings and Do Not Disturb, the site's notification permission, and that the app's service worker is installed.");
  }

  for (const t of types) {
    if (!t.policyAllows) add(`Push is turned off for "${t.type}" by the admin notification policy.`);
    if (!t.preferenceAllows) add(`You have turned off push for "${t.type}" in your notification preferences.`);
  }

  return hints;
}
