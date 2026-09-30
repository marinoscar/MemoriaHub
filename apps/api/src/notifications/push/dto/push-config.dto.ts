import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { vapidSubjectSchema } from '../push-config.schema';

// =============================================================================
// /api/admin/push-config request bodies (epic #481, issue #483)
// =============================================================================
//
// Neither VAPID key is settable through any of these bodies: the public key is
// server-derived by generate/rotate, and the private key never travels over
// the wire in either direction.
// =============================================================================

/** PUT — partial update of the two day-to-day switches. */
export const updatePushConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** `null` clears it back to the generic fallback subject. */
    subject: vapidSubjectSchema.nullable().optional(),
  })
  .strict();
export type UpdatePushConfigInput = z.infer<typeof updatePushConfigSchema>;
export class UpdatePushConfigDto extends createZodDto(updatePushConfigSchema) {}

/** POST generate — first-time key generation; refuses (409) if keys exist. */
export const generatePushConfigSchema = z
  .object({ subject: vapidSubjectSchema.nullable().optional() })
  .strict();
export type GeneratePushConfigInput = z.infer<typeof generatePushConfigSchema>;
export class GeneratePushConfigDto extends createZodDto(generatePushConfigSchema) {}

/**
 * Typed confirmations for the two destructive actions. Deliberately DIFFERENT
 * words (same pattern as the database restore's RESTORE/ROLLBACK), so a body
 * replayed or copied from one route to the other is a 400 that starts nothing.
 */
export const ROTATE_CONFIRMATION = 'ROTATE';
export const REMOVE_CONFIRMATION = 'REMOVE';

export const rotatePushConfigSchema = z
  .object({
    confirmation: z.literal(ROTATE_CONFIRMATION),
    /** Omitted keeps the stored subject — rotation replaces the keys, not the contact. */
    subject: vapidSubjectSchema.nullable().optional(),
  })
  .strict();
export type RotatePushConfigInput = z.infer<typeof rotatePushConfigSchema>;
export class RotatePushConfigDto extends createZodDto(rotatePushConfigSchema) {}

export const removePushConfigSchema = z
  .object({ confirmation: z.literal(REMOVE_CONFIRMATION) })
  .strict();
export type RemovePushConfigInput = z.infer<typeof removePushConfigSchema>;
export class RemovePushConfigDto extends createZodDto(removePushConfigSchema) {}

// -----------------------------------------------------------------------------
// Response (the admin view)
// -----------------------------------------------------------------------------

export interface PushPrivateKeyStatus {
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
}

/**
 * What every /api/admin/push-config route returns. The private key is absent in
 * every form — see the compile-time proof below.
 */
export interface PushConfigAdminView {
  enabled: boolean;
  publicKey: string | null;
  /** The stored subject (`null` = generic fallback in use). */
  subject: string | null;
  /** The subject actually signed with: `subject ?? DEFAULT_VAPID_SUBJECT`. */
  effectiveSubject: string;
  /** Both halves of the key pair are present. */
  configured: boolean;
  /** `enabled && configured` — push can be sent right now. */
  active: boolean;
  privateKeyStatus: PushPrivateKeyStatus;
  /** Field paths of a stored row that failed validation, else null. */
  settingsError: string | null;
  updatedAt: string | null;
  updatedById: string | null;
}

type SecretFieldNames =
  | 'privateKey'
  | 'privateKeyEncrypted'
  | 'vapidPrivateKey'
  | 'secret'
  | 'ciphertext';

/** Compile-time proof: adding a secret-named field to the view breaks the build. */
export type PushConfigAdminViewCarriesNoSecret =
  Extract<keyof PushConfigAdminView | keyof PushPrivateKeyStatus, SecretFieldNames> extends never
    ? true
    : never;
export const PUSH_CONFIG_ADMIN_VIEW_CARRIES_NO_SECRET: PushConfigAdminViewCarriesNoSecret = true;
