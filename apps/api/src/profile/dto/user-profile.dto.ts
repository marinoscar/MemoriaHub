import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Profile picture management DTOs (issue #354).
 *
 * All three self-service routes are scoped to the JWT's own `userId`, so none
 * of these carry a user id — the caller can only ever describe their own
 * profile.
 */

// ---------------------------------------------------------------------------
// PATCH /api/users/me/profile
// ---------------------------------------------------------------------------

/**
 * Every field is optional and each is independently actionable:
 *
 *   - `displayName` — written through UserSettingsService (which remains the
 *     single writer of `User.displayName`, via its `syncDisplayName`). `null`
 *     clears the override so the provider name shows again.
 *   - `linkedPersonId` — a uuid links this account to a Person ("this Person is
 *     me") AND re-renders the avatar from that person; `null` unlinks WITHOUT
 *     touching the picture (the two are deliberately separate concerns — see
 *     UserAvatarService).
 *   - `avatarSource` — switches which picture is displayed. `oauth` resets to
 *     the provider picture, `person` re-renders from the linked person. There
 *     is no way to *select* `upload` here: uploaded bytes only ever arrive
 *     through `POST /api/users/me/avatar`, which sets the source itself.
 *
 * A PATCH that carries only `displayName` never touches the avatar.
 *
 * The trailing `.default({})` maps a bodyless request to `{}` before the object
 * schema sees it — Fastify leaves `request.body` as `undefined` when no body is
 * sent and `z.object({...}).parse(undefined)` throws regardless of how optional
 * its fields are (same rationale as NotificationScopeDto).
 */
export const updateUserProfileSchema = z
  .object({
    displayName: z.string().max(100).nullable().optional(),
    avatarSource: z.enum(['oauth', 'upload', 'person']).optional(),
    linkedPersonId: z.string().uuid().nullable().optional(),
  })
  .default({});

export class UpdateUserProfileDto extends createZodDto(updateUserProfileSchema) {}

// ---------------------------------------------------------------------------
// Response shape — shared by GET and PATCH /api/users/me/profile
// ---------------------------------------------------------------------------

/**
 * The Person this account is linked to, or `null`.
 *
 * `null` covers BOTH "never linked" and "the linked person was soft-deleted or
 * hard-deleted out from under the link" — in the latter case a user can be left
 * at `avatarSource: 'person'` still serving the last-rendered bytes, and this
 * field going null is how the UI learns to offer a re-link.
 */
export const linkedPersonSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  circleId: z.string().uuid(),
  circleName: z.string(),
});

export const userProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  /** Override-then-provider, resolved exactly like AuthService.getCurrentUser. */
  displayName: z.string().nullable(),
  /**
   * The materialized resolved avatar URL — the same value stored in
   * `User.profileImageUrl`, which is what every existing consumer (auth/me,
   * circle member lists, the admin users table) already reads.
   */
  avatarUrl: z.string().nullable(),
  avatarSource: z.enum(['oauth', 'upload', 'person']),
  /** Surfaced so the UI can preview/offer "reset to the OAuth picture". */
  providerProfileImageUrl: z.string().nullable(),
  linkedPerson: linkedPersonSchema.nullable(),
});

export class UserProfileDto extends createZodDto(userProfileSchema) {}
