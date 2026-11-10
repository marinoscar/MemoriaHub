import { applyDecorators, createParamDecorator, SetMetadata, UseGuards, type ExecutionContext } from '@nestjs/common';
import { ApiBearerAuth, ApiExtension, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';

import type { MemoriahubCredential, MemoriahubCredentialKind } from '../../ports/index.js';
import {
  MEMORIAHUB_ANY_PERMISSIONS_KEY,
  MEMORIAHUB_CREDENTIALS_KEY,
  MEMORIAHUB_IS_PUBLIC_KEY,
  MEMORIAHUB_PERMISSIONS_KEY,
  MEMORIAHUB_RBAC_EXTENSION_KEY,
  MEMORIAHUB_REQUEST_CREDENTIAL_PROPERTY,
  MEMORIAHUB_REQUEST_USER_PROPERTY,
  MEMORIAHUB_ROLES_KEY,
  MEMORIAHUB_SESSION_SCHEME,
} from './memoriahub-auth.constants.js';
import { MemoriahubAuthGuard } from './memoriahub-auth.guard.js';

/**
 * What a route needs. All fields are optional: `@MemoriahubAuth()` alone means "any signed-in caller".
 *
 * @stability experimental
 */
export interface MemoriahubAuthOptions {
  /** The caller must hold at least one of these roles. */
  roles?: readonly string[];
  /** The caller must hold every one of these permissions. */
  permissions?: readonly string[];
  /** The caller must hold at least one of these permissions. */
  anyPermissions?: readonly string[];
  /** The credential kinds the route accepts. Omitted: every kind the host authenticates. */
  credentials?: readonly MemoriahubCredentialKind[];
  /** Marks the route public: no authentication, no guard. */
  public?: boolean;
}

/**
 * The caller as a controller reads it: the fields every slice needs, whatever the host.
 *
 * @stability experimental
 */
export interface MemoriahubRequestUser {
  /** The user id. */
  id: string;
  /** The role names the caller holds. */
  roles: string[];
  /** Every permission string the caller holds. */
  permissions: string[];
  /** The active organization, or `null`. */
  activeOrgId: string | null;
}

/** The OpenAPI schema reference of the host's error envelope (the host registers the `ErrorDto` component). */
const ERROR_SCHEMA = { $ref: '#/components/schemas/ErrorDto' } as const;

/**
 * Marks a route public: no guard runs and the document lists no security requirement.
 *
 * @stability experimental
 */
export const MemoriahubPublic = (): MethodDecorator & ClassDecorator => SetMetadata(MEMORIAHUB_IS_PUBLIC_KEY, true);

/**
 * Protects a route: authenticates through the `MEMORIAHUB_IDENTITY` port, then checks the roles,
 * permissions and credential kinds it names. Documents the route with the bearer scheme and the
 * `x-rbac` extension, exactly like the web edition's `@Auth()`.
 *
 * @param options - what the route needs.
 * @stability experimental
 */
export function MemoriahubAuth(options: MemoriahubAuthOptions = {}): MethodDecorator & ClassDecorator {
  if (options.public) return MemoriahubPublic();

  const roles = options.roles ?? [];
  const permissions = options.permissions ?? [];
  const anyPermissions = options.anyPermissions ?? [];

  const rbac = {
    authenticated: true,
    roles: [...roles],
    permissions: [...permissions],
    ...(anyPermissions.length > 0 ? { anyPermissions: [...anyPermissions] } : {}),
  };

  const decorators: Array<MethodDecorator | ClassDecorator> = [
    UseGuards(MemoriahubAuthGuard),
    ApiBearerAuth(MEMORIAHUB_SESSION_SCHEME),
    ApiExtension(MEMORIAHUB_RBAC_EXTENSION_KEY, rbac),
    ApiUnauthorizedResponse({ description: 'Unauthorized - Invalid or missing token', schema: ERROR_SCHEMA }),
    ApiForbiddenResponse({ description: 'Forbidden - Insufficient permissions', schema: ERROR_SCHEMA }),
  ];
  if (roles.length > 0) decorators.push(SetMetadata(MEMORIAHUB_ROLES_KEY, [...roles]));
  if (permissions.length > 0) decorators.push(SetMetadata(MEMORIAHUB_PERMISSIONS_KEY, [...permissions]));
  if (anyPermissions.length > 0) decorators.push(SetMetadata(MEMORIAHUB_ANY_PERMISSIONS_KEY, [...anyPermissions]));
  if (options.credentials && options.credentials.length > 0) {
    decorators.push(SetMetadata(MEMORIAHUB_CREDENTIALS_KEY, [...options.credentials]));
  }
  return applyDecorators(...decorators);
}

/**
 * The user the guard attached to a request, or `undefined` on a route the guard did not run on.
 *
 * @stability experimental
 */
export function memoriahubUserOf(request: unknown): MemoriahubRequestUser | undefined {
  return (request as Record<string, MemoriahubRequestUser | undefined> | undefined)?.[MEMORIAHUB_REQUEST_USER_PROPERTY];
}

/**
 * The credential the guard attached to a request, or `null`.
 *
 * @stability experimental
 */
export function memoriahubCredentialOf(request: unknown): MemoriahubCredential | null {
  return (request as Record<string, MemoriahubCredential | undefined> | undefined)?.[MEMORIAHUB_REQUEST_CREDENTIAL_PROPERTY] ?? null;
}

/**
 * Parameter decorator: the caller as a {@link MemoriahubRequestUser}. `@MemoriahubCurrentUser('id')`
 * reads one field.
 *
 * @stability experimental
 */
export const MemoriahubCurrentUser = createParamDecorator((field: keyof MemoriahubRequestUser | undefined, ctx: ExecutionContext) => {
  const user = memoriahubUserOf(ctx.switchToHttp().getRequest());
  return field ? user?.[field] : user;
});

/**
 * Parameter decorator: the credential the caller authenticated with (`{ kind, tokenId? }`), or `null`.
 *
 * @stability experimental
 */
export const MemoriahubAuthCredential = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  memoriahubCredentialOf(ctx.switchToHttp().getRequest()),
);
