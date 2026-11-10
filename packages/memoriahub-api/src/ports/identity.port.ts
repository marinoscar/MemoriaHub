import type { ExecutionContext } from '@nestjs/common';

// =============================================================================
// MEMORIAHUB_IDENTITY: the request-identity port (RETRO-J4, #610)
// =============================================================================
//
// Who is calling, and what may they do. The web edition authenticates a request
// with the platform guards; a bare host binds its own.
//
// THE PORT RETURNS A NORMALISED PRINCIPAL OR `null`. A slice never reads
// permissions off a raw user object: on a route with no declared permission the
// platform guards attach no normalised user, and a slice that read one would
// silently see none (the permissionless-route trap). Only the adapter reads the
// host's own request shape.
// =============================================================================

/**
 * Injection token of {@link MemoriahubIdentityPort}. The description string is
 * permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_IDENTITY = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_IDENTITY');

/**
 * The caller, as the port normalises it.
 *
 * @stability experimental
 */
export interface MemoriahubPrincipal {
  /** The user id. */
  userId: string;
  /** The active organization, or `null` when the credential has none. */
  orgId: string | null;
  /** The role names the caller holds. */
  roles: readonly string[];
  /** Every permission string the caller holds in the active organization. */
  permissions: ReadonlySet<string>;
}

/**
 * The identity port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubIdentityPort {
  /**
   * Authenticates the request behind a Nest execution context.
   *
   * @param context - the execution context of the request.
   * @returns the principal, or `null` when the request carries no valid credential.
   */
  authenticate(context: ExecutionContext): Promise<MemoriahubPrincipal | null>;

  /**
   * Whether a user holds a permission, read fresh from the host. `false` for an
   * unknown or inactive user.
   *
   * @param userId - the user.
   * @param permission - a permission string.
   */
  hasPermission(userId: string, permission: string): Promise<boolean>;

  /**
   * Every permission string a user holds, read fresh from the host. Empty for an
   * unknown or inactive user. Used by background code that acts for a user and has
   * no request to read a principal from.
   *
   * @param userId - the user.
   */
  permissionsOf(userId: string): Promise<readonly string[]>;
}
