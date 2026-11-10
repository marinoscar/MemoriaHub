// =============================================================================
// Metadata keys and request properties of the identity-backed guard (RETRO-J5, #613)
// =============================================================================
//
// The metadata keys equal the strings the web edition's `@Auth()` writes (`roles`, `permissions`,
// `anyPermissions`, `isPublic`), so tooling that reflects on a route (the permission matrix, the
// OpenAPI document pass reading `x-rbac`) sees the same route whichever decorator declared it.
// =============================================================================

/**
 * Reflect metadata key of the roles a route requires.
 *
 * @stability experimental
 */
export const MEMORIAHUB_ROLES_KEY = 'roles';

/**
 * Reflect metadata key of the permissions a route requires (all of them).
 *
 * @stability experimental
 */
export const MEMORIAHUB_PERMISSIONS_KEY = 'permissions';

/**
 * Reflect metadata key of the permissions of which a route requires at least one.
 *
 * @stability experimental
 */
export const MEMORIAHUB_ANY_PERMISSIONS_KEY = 'anyPermissions';

/**
 * Reflect metadata key marking a route public.
 *
 * @stability experimental
 */
export const MEMORIAHUB_IS_PUBLIC_KEY = 'isPublic';

/**
 * Reflect metadata key of the credential kinds a route accepts.
 *
 * @stability experimental
 */
export const MEMORIAHUB_CREDENTIALS_KEY = 'memoriahub:credentials';

/**
 * The OpenAPI extension that documents a route's requirements. The document pass of the host reads it.
 *
 * @stability experimental
 */
export const MEMORIAHUB_RBAC_EXTENSION_KEY = 'x-rbac';

/**
 * The name of the bearer security scheme a protected route declares.
 *
 * @stability experimental
 */
export const MEMORIAHUB_SESSION_SCHEME = 'JWT-auth';

/**
 * The request property the guard stores the caller under (a `MemoriahubRequestUser`).
 *
 * @stability experimental
 */
export const MEMORIAHUB_REQUEST_USER_PROPERTY = 'memoriahubUser';

/**
 * The request property the guard stores the credential under (a `MemoriahubCredential`).
 *
 * @stability experimental
 */
export const MEMORIAHUB_REQUEST_CREDENTIAL_PROPERTY = 'memoriahubCredential';

/**
 * The request property an identity binding stores the message of a rejected authentication under, so
 * the guard answers with the host's own 401 body.
 *
 * @stability experimental
 */
export const MEMORIAHUB_AUTH_FAILURE_PROPERTY = 'memoriahubAuthFailure';
