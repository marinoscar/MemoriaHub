import { z } from 'zod';

// =============================================================================
// Web Push (VAPID) configuration — stored shape (epic #481, issue #483)
// =============================================================================
//
// Persisted as the `system_settings` row with key `webPush` — a SEPARATE row
// from the main `global` settings document. That separation is load-bearing:
// `GET /api/system-settings` and every `SystemSettingsService` read touch only
// key `global`, so the encrypted private key below can never ride out on the
// generic settings response. The only reader of this row is PushConfigService
// (plus PushTestService's source diagnostics).
//
// NO ENVIRONMENT VARIABLE FALLBACK. Web Push is a runtime-configured feature
// (CLAUDE.md "Security guidelines": storage, AI, Web Push and SMTP never get
// env vars — two sources of truth is the failure that rule prevents). No row
// means "not configured", full stop.
//
// The PRIVATE key is stored AES-256-GCM encrypted (`encryptSecret`, keyed by
// SECRETS_ENCRYPTION_KEY) and is NEVER returned by any endpoint: the admin view
// exposes only `privateKeyStatus` ({ configured, last4, updatedAt }).
// =============================================================================

/**
 * Fallback VAPID subject when none is configured. Its only effect is what a
 * push-service operator sees if this deployment's traffic looks abusive.
 */
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@example.com';

/** The `system_settings.key` this configuration is stored under. */
export const PUSH_CONFIG_KEY = 'webPush';

/**
 * A VAPID subject: a `mailto:` address or an `https://` URL. `web-push`
 * rejects anything else at send time, and Apple's push service rejects plain
 * `http://` — validating here turns both into a 400 on save rather than a
 * delivery failure hours later.
 */
export const vapidSubjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      /^mailto:[^\s@]+@[^\s@]+$/.test(value) || /^https:\/\/[^\s/]+/.test(value),
    { message: 'VAPID subject must be a mailto: address or an https:// URL' },
  );

/**
 * The stored row. Tolerant on read (`safeParse`): a hand-edited or corrupted
 * row degrades to "push is off", never to a 500 on the admin page that repairs
 * it.
 */
export const storedPushConfigSchema = z.object({
  enabled: z.boolean(),
  publicKey: z.string().min(1).nullable(),
  subject: z.string().nullable(),
  /** AES-256-GCM ciphertext (base64) of the VAPID private key. NEVER returned. */
  privateKeyEncrypted: z.string().min(1).nullable(),
  /** Last four characters of the private key, for the admin's "which key" display. */
  privateKeyLast4: z.string().nullable(),
  /** ISO timestamp of the last write to this row (any action). */
  updatedAt: z.string().nullable(),
  updatedById: z.string().nullable(),
});

export type StoredPushConfig = z.infer<typeof storedPushConfigSchema>;

export const EMPTY_PUSH_CONFIG: StoredPushConfig = {
  enabled: false,
  publicKey: null,
  subject: null,
  privateKeyEncrypted: null,
  privateKeyLast4: null,
  updatedAt: null,
  updatedById: null,
};
