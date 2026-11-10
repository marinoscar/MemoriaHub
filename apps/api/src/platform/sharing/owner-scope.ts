// =============================================================================
// Owner scopes: circle access decided by platform group membership
// (RETRO-I3, #573; epic #556; mapping docs/platform-adoption/circles-to-groups.md §6, §7)
// =============================================================================
//
// Every MemoriaHub route still names its owner scope with the id it always
// had (`circleId`, now also accepted as `ownerGroupId` by the routes that read
// the scope from the request). Since RETRO-I2 that id is either
//
//   - a GROUP id: a shared circle's id IS its group's id (decision 1), and the
//     caller's role is its `group_members` role, read through the sharing
//     slice's `PrincipalGroupsProvider` (cached, invalidated on membership
//     writes: `OwnerAccessService.invalidateMembers`); or
//   - a personal circle's id: no group exists, the rows are owned by the
//     circle's owner (`owner_user_id`), and only that user may act (as `admin`).
//
// The decision, in order (exactly the former `OwnerAccessService` rules,
// except the deliberate 403 -> 404 for a non-member, §6):
//
//   1. super-admin bypass: `groups:admin` (was `circles:manage_any`, still
//      honoured for one release), `media:write_any`, `media:read_any`;
//   2. unknown scope -> 404;
//   3. not the owner and not a member -> 404 (was 403): the scope's existence
//      is hidden, the same body as an unknown scope;
//   4. a member below the required role -> 403 (the scope is visible to them).
//
// Roles: `circle_admin` -> `admin`, `collaborator` -> `editor`, `viewer` ->
// `viewer` (the group role registry's ranks: manage 3, write 2, read 1).
//
// A personal scope is told from a group one by the `PersonalLibraryStore` (RETRO-K1);
// any other id is a group id.
// =============================================================================

import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { UserPrincipal } from '@marinoscar/platform-api/core';
import {
  PrincipalGroupsProvider,
  SHARING_PERMISSIONS,
  groupRoleAtLeast,
  type ResourceOwner,
} from '@marinoscar/platform-api/sharing';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { DefaultOrgId } from '../../common/tenancy/default-org-id';
import { PersonalLibraryStore } from './personal-library.store';

/** A role inside an owner scope: the platform's built-in group roles. */
export type OwnerRole = 'viewer' | 'editor' | 'admin';

/** The former per-circle role names, mapped to group roles (§2). */
export const LEGACY_CIRCLE_ROLE_TO_OWNER_ROLE: Readonly<Record<'viewer' | 'collaborator' | 'circle_admin', OwnerRole>> =
  Object.freeze({ viewer: 'viewer', collaborator: 'editor', circle_admin: 'admin' });

/**
 * Permissions that act on any owner scope without being a member: the
 * resource types' `bypassPermissions` plus `groups:admin`. `circles:manage_any`
 * is the deprecated name of `groups:admin`, kept one release (expand/contract).
 */
export const OWNER_BYPASS_PERMISSIONS: readonly string[] = Object.freeze([
  SHARING_PERMISSIONS.GROUPS_ADMIN,
  PERMISSIONS.CIRCLES_MANAGE_ANY,
  PERMISSIONS.MEDIA_WRITE_ANY,
  PERMISSIONS.MEDIA_READ_ANY,
]);

/** Whether `permissions` carry an owner-scope bypass. */
export function hasOwnerBypass(permissions: readonly string[] | undefined | null): boolean {
  return !!permissions && OWNER_BYPASS_PERMISSIONS.some((permission) => permissions.includes(permission));
}

/** The result of a passed check. */
export interface OwnerAccess {
  /** The caller's role in the scope (`admin` for a personal library's owner), or `null` for a bypassing non-member. */
  role: OwnerRole | null;
  /** True when the caller passed through a bypass permission. */
  isSuperAdmin: boolean;
}

/** The body of every "not found or not yours" refusal: one message, so ids cannot be probed. */
function scopeNotFound(scopeId: string): NotFoundException {
  return new NotFoundException(`Circle ${scopeId} not found`);
}

@Injectable()
export class OwnerAccessService {
  private readonly logger = new Logger(OwnerAccessService.name);

  constructor(
    private readonly personal: PersonalLibraryStore,
    private readonly principalGroups: PrincipalGroupsProvider,
    private readonly defaultOrgId: DefaultOrgId,
  ) {}

  /**
   * The owner of a scope id: the circle's owner for a personal circle, the
   * group of the same id otherwise; `null` for an unknown id.
   */
  async resolveOwner(scopeId: string): Promise<ResourceOwner | null> {
    const ownerId = await this.personal.ownerOf(scopeId);
    if (ownerId) return { kind: 'user', userId: ownerId };
    // Not a personal library: a group of the same id. No group lookup here (the slice
    // answers "not a member" for an unknown id, which is the 404 of an unknown scope).
    return { kind: 'group', groupId: scopeId };
  }

  /** The user's personal library id, or `null` when they have none. */
  async personalLibraryOf(userId: string): Promise<string | null> {
    return this.personal.idOf(userId);
  }

  /**
   * The groups the user can write in (role `editor` or `admin`), by id. The
   * membership comes from the slice's `PrincipalGroupsProvider` (cached).
   */
  async writableGroupsOf(userId: string): Promise<string[]> {
    const memberships = await this.principalGroups.groupsFor(await this.principalFor(userId));
    return memberships
      .filter((m) => m.role === 'editor' || m.role === 'admin')
      .map((m) => m.groupId)
      .sort();
  }

  /**
   * The user's role in each scope they belong to: their personal library as
   * `admin`, then each group with their group role.
   */
  async rolesOf(userId: string): Promise<Array<{ scopeId: string; role: OwnerRole; personal: boolean }>> {
    const personal = await this.personal.idOf(userId);
    const memberships = await this.principalGroups.groupsFor(await this.principalFor(userId));
    const out: Array<{ scopeId: string; role: OwnerRole; personal: boolean }> = memberships
      .map((m) => ({ scopeId: m.groupId, role: m.role as OwnerRole, personal: false }))
      .sort((a, b) => a.scopeId.localeCompare(b.scopeId));
    return personal ? [{ scopeId: personal, role: 'admin', personal: true }, ...out] : out;
  }

  /**
   * Every scope id the user belongs to: their personal library, then every
   * group they are a member of (any role).
   */
  async scopesOf(userId: string): Promise<string[]> {
    const personal = await this.personal.idOf(userId);
    const memberships = await this.principalGroups.groupsFor(await this.principalFor(userId));
    const ids = memberships.map((m) => m.groupId).sort();
    return personal ? [personal, ...ids] : ids;
  }

  /**
   * The caller's role in a scope (`admin` for the owner of a personal
   * library), or `null` when the scope is unknown or the caller holds none.
   */
  async roleIn(userId: string, scopeId: string): Promise<OwnerRole | null> {
    const owner = await this.resolveOwner(scopeId);
    return owner ? this.roleForOwner(userId, owner) : null;
  }

  /** The caller's role for a resolved owner. */
  async roleForOwner(userId: string, owner: ResourceOwner): Promise<OwnerRole | null> {
    if (owner.kind === 'user') return owner.userId === userId ? 'admin' : null;
    const role = await this.principalGroups.groupRoleFor(await this.principalFor(userId), owner.groupId);
    return (role as OwnerRole | null) ?? null;
  }

  /**
   * Refuses unless the caller holds at least `minRole` in the scope (or a
   * bypass permission). 404 for an unknown scope and for a non-member, 403
   * for a member below `minRole`.
   */
  async requireOwnerRole(
    userId: string,
    scopeId: string,
    permissions: readonly string[],
    minRole: OwnerRole,
  ): Promise<OwnerAccess> {
    if (hasOwnerBypass(permissions)) {
      return { role: await this.roleIn(userId, scopeId), isSuperAdmin: true };
    }
    const owner = await this.resolveOwner(scopeId);
    if (!owner) throw scopeNotFound(scopeId);
    const role = await this.roleForOwner(userId, owner);
    if (role === null) throw scopeNotFound(scopeId);
    if (!groupRoleAtLeast(role, minRole)) {
      throw new ForbiddenException(`This action requires ${minRole} role or higher`);
    }
    return { role, isSuperAdmin: false };
  }

  /**
   * Drops the cached group memberships of `userIds` (here and on every
   * replica). Call it after a membership write commits, outside any
   * transaction. Never throws.
   */
  invalidateMembers(userIds: readonly string[]): void {
    if (userIds.length === 0) return;
    try {
      this.principalGroups.invalidateUsers(userIds);
    } catch (err) {
      this.logger.warn(`Membership cache invalidation failed: ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }

  /**
   * The principal the membership lookup runs for. MemoriaHub is single
   * organization (`TENANCY_MODE=single`, D6): every group lives in the default
   * organization, so the caller's active organization is that one whatever
   * credential carried the request (a job's actor has no request at all).
   * PLATFORM-ADOPTION-SHIM(RETRO-MULTI-ORG): multi-organization mode needs the
   * request's principal here.
   */
  private async principalFor(userId: string): Promise<UserPrincipal> {
    return {
      kind: 'user',
      userId,
      email: '',
      credential: 'session',
      roles: [],
      permissions: [],
      activeOrgId: await this.defaultOrgId.get(),
    };
  }
}
