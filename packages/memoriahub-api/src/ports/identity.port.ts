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
 * The kind of credential a request authenticated with.
 *
 * @stability experimental
 */
export type MemoriahubCredentialKind = 'jwt' | 'pat' | 'node';

/**
 * How the request authenticated.
 *
 * @stability experimental
 */
export interface MemoriahubCredential {
  /** The credential kind. */
  kind: MemoriahubCredentialKind;
  /** The id of the stored token, for a kind that has one (`pat`). */
  tokenId?: string;
}

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
  /** The credential the request authenticated with, when the host tells. */
  credential?: MemoriahubCredential;
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
   * @returns the principal, or `null` when the request carries no valid credential. A binding that
   *   rejects with a message of its own stores it on the request under
   *   `MEMORIAHUB_AUTH_FAILURE_PROPERTY` so the guard answers with it; one that must refuse for another
   *   reason (a credential used on a route it may not reach) throws the 403 itself.
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
