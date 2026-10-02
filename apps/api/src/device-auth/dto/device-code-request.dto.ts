import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Sanitizes a device-flow `returnUri`.
 *
 * Only the following schemes are accepted:
 * - `memoriahub:` — custom Android/iOS deep-link scheme
 * - `https:`       — standard secure web URL
 *
 * Anything else (http, javascript, data, etc.) is rejected and null is returned.
 * The value is also capped at 512 characters before the scheme check.
 *
 * @returns The original URI string if accepted, or null if rejected/absent.
 */
export function sanitizeReturnUri(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.length > 512) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith('memoriahub:')) return value;
  if (lower.startsWith('https:')) return value;
  return null;
}

/**
 * The kind of credential a device asks the flow to mint on approval.
 *
 * - `'session'` (and an ABSENT `tokenType`) is the historical behaviour: a JWT
 *   access token plus a refresh token, valid `DEVICE_TOKEN_EXPIRY_DAYS`. The
 *   web activation page and every legacy client send no `tokenType`, so
 *   absence must keep meaning session.
 * - `'pat'` is what the CLI and the Android app ask for: a long-lived,
 *   revocable personal access token (`pat_...`).
 *
 * An unrecognised value (a typo'd `'PAT'`, a probe sending `'admin'`) is
 * REJECTED with a 400 rather than silently falling back: a device that asked
 * for something we do not understand must not be handed a credential of our
 * choosing. Issue #499.
 */
export const DeviceTokenTypeSchema = z.enum(['session', 'pat']);

export type DeviceTokenType = z.infer<typeof DeviceTokenTypeSchema>;

/**
 * Client info schema for device authorization requests.
 *
 * This is an explicit ALLOWLIST, deliberately not `.passthrough()`: every
 * field arrives from an UNAUTHENTICATED caller (`POST /auth/device/code` is
 * `@Public()`), is persisted verbatim into `device_codes.client_info`, and is
 * later rendered to a human who trusts it (the activation page, and for a PAT
 * the Access Tokens list). The global `ZodValidationPipe` strips any key not
 * listed here — which is exactly how `tokenType`/`name` were silently dropped
 * before issue #499, turning every CLI login into a 7-day session. A field a
 * client needs to send MUST be added here, with a bound.
 */
export const ClientInfoSchema = z.object({
  deviceName: z.string().max(255).optional(),
  userAgent: z.string().max(1024).optional(),
  /** Credential kind to mint on approval; absent means `session`. */
  tokenType: DeviceTokenTypeSchema.optional(),
  /**
   * Human-readable client label, e.g. `"MemoriaHub CLI"` or
   * `"MemoriaHub Android · Pixel 8"`. Shown on the activation page and, for a
   * PAT, used as the token's name in the Access Tokens list.
   */
  name: z.string().trim().max(100).optional(),
  /** Requesting machine's hostname (informational, shown on activation). */
  hostname: z.string().max(255).optional(),
  /** Requesting machine's platform, e.g. `linux`, `android` (informational). */
  platform: z.string().max(50).optional(),
  /**
   * Optional deep-link URI the web activation page uses to redirect the user
   * back into the requesting app after approval.
   * Accepted schemes: `memoriahub:` or `https:`.
   */
  returnUri: z
    .string()
    .max(512)
    .optional()
    .refine(
      (v) => v === undefined || sanitizeReturnUri(v) !== null,
      { message: 'returnUri must use the memoriahub: or https: scheme' },
    ),
});

export type DeviceClientInfo = z.infer<typeof ClientInfoSchema>;

/**
 * Request DTO for initiating device authorization flow
 */
export const DeviceCodeRequestSchema = z.object({
  clientInfo: ClientInfoSchema.optional(),
  // .default({}) so a bodyless POST parses as {} — see issue #289 (app.module.ts).
}).default({});

export class DeviceCodeRequestDto extends createZodDto(DeviceCodeRequestSchema) {
  @ApiProperty({
    description:
      'Optional client information. `tokenType` selects the credential minted when the ' +
      'device polls `POST /auth/device/token` after the user approves: `session` (or absent) ' +
      'returns a JWT plus a refresh token valid `DEVICE_TOKEN_EXPIRY_DAYS`; `pat` returns a ' +
      'long-lived, revocable personal access token (`pat_...`) tagged `credentialType: "pat"`. ' +
      'An unrecognised `tokenType` is rejected with a 400. `name` (max 100) is shown on the ' +
      'activation page and becomes the PAT name in the Access Tokens list. `hostname` (max 255) ' +
      'and `platform` (max 50) are informational. `returnUri` must use the `memoriahub:` or ' +
      '`https:` scheme (max 512). Unknown keys are stripped.',
    required: false,
    example: {
      tokenType: 'pat',
      name: 'MemoriaHub CLI',
      hostname: 'oscar-laptop',
      platform: 'linux',
    },
  })
  // Typed from the schema rather than re-declared by hand, so the two can
  // never drift apart again (issue #499).
  clientInfo?: DeviceClientInfo;
}
