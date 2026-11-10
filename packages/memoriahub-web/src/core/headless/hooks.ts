import { useMemo } from 'react';

import { useMemoriahubHost } from './host.js';
import type { MemoriahubFeatures, MemoriahubPrincipal } from './host.js';
import type { MemoriahubOwnerScopeValue } from './owner-scope.js';

/**
 * The active owner scope (RETRO-I6): "My library" or one group, the caller's
 * role in it and the legacy `circle` fields.
 *
 * @returns the host's owner-scope value.
 *
 * @stability experimental
 */
export function useOwnerScope(): MemoriahubOwnerScopeValue {
  return useMemoriahubHost().ownerScope;
}

/**
 * The signed-in user.
 *
 * @returns the principal, `null` while nobody is signed in.
 *
 * @stability experimental
 */
export function usePrincipal(): MemoriahubPrincipal | null {
  return useMemoriahubHost().principal;
}

/**
 * Read-only feature flags for any authenticated user (`GET /api/features`).
 *
 * @returns the host's feature state; a failed read leaves the flags `null`, it never throws.
 *
 * @stability experimental
 */
export function useFeatureFlags(): MemoriahubFeatures {
  return useMemoriahubHost().features;
}

/**
 * The result of {@link usePermissions}.
 *
 * @stability experimental
 */
export interface MemoriahubPermissions {
  /** The permission strings the user holds. */
  permissions: ReadonlySet<string>;
  /** The names of the user's roles. */
  roles: ReadonlySet<string>;
  /** True when the user holds `permission`. */
  hasPermission: (permission: string) => boolean;
  /** True when the user holds any of `perms`. */
  hasAnyPermission: (...perms: string[]) => boolean;
  /** True when the user holds all of `perms`. */
  hasAllPermissions: (...perms: string[]) => boolean;
  /** True when the user has the role. */
  hasRole: (role: string) => boolean;
  /** True when the user has any of the roles. */
  hasAnyRole: (...roleList: string[]) => boolean;
  /** True for the `admin` role. */
  isAdmin: boolean;
}

/**
 * The signed-in user's permissions and roles, with the checks the pages use.
 *
 * @returns the permission helpers.
 *
 * @stability experimental
 */
export function usePermissions(): MemoriahubPermissions {
  const { principal } = useMemoriahubHost();
  return useMemo(() => {
    const permissions = new Set<string>(principal?.permissions ?? []);
    const roles = new Set<string>(principal?.roles ?? []);
    return {
      permissions,
      roles,
      hasPermission: (permission) => permissions.has(permission),
      hasAnyPermission: (...perms) => perms.some((p) => permissions.has(p)),
      hasAllPermissions: (...perms) => perms.every((p) => permissions.has(p)),
      hasRole: (role) => roles.has(role),
      hasAnyRole: (...list) => list.some((r) => roles.has(r)),
      isAdmin: roles.has('admin'),
    };
  }, [principal]);
}
