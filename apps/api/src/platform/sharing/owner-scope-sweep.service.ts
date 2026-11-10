import { Injectable } from '@nestjs/common';
import {
  GroupMembershipService,
  GroupsService,
  SHARING_PERMISSIONS,
  type SharingSystemAccessReason,
} from '@marinoscar/platform-api/sharing';

import { OWNER_SCOPE_MEMBERS_REASON, OWNER_SCOPE_SWEEP_REASON } from '../../app-registrations/system-access-reasons';
import { DefaultOrgId } from '../../common/tenancy/default-org-id';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonalLibraryStore, personalLibraryName } from './personal-library.store';

// =============================================================================
// Every owner scope, for an admin sweep or a cron (RETRO-N29 #1137, RETRO-K1 #588)
// =============================================================================
//
// The admin backfills, the location rebuild and the memories / review-queue
// crons walk "every library": every shared library plus one personal library per
// user (an owner scope id, see `docs/platform-adoption/circles-to-groups.md`
// §8). Shared libraries are platform groups, listed through
// `GroupsService.listForSystem` and read through
// `GroupMembershipService.membersForSystem` under registered system access
// reasons (no organization: every organization, on the system client). A
// personal library is not a group: it comes from the `PersonalLibraryStore`,
// whose single owner is the user. Nothing here reads `circles`, `circle_members`
// or `groups` itself.
// =============================================================================

/** The slice's page size ceiling for `listForSystem` (`SYSTEM_GROUPS_MAX_LIMIT`). */
const GROUP_PAGE_SIZE = 500;
const PERSONAL_PAGE_SIZE = 500;

/** A role inside an owner scope (the platform's built-in group roles). */
export type ScopeRole = 'viewer' | 'editor' | 'admin';

/** One owner scope as a sweep sees it. */
export interface ScopeSummary {
  /** The scope id: a group id, or a personal library's id. */
  id: string;
  /** Display name (a group's name, or "<owner>'s Library"). */
  name: string;
  kind: 'group' | 'personal';
  /** The owning user of a personal library; `null` for a group. */
  ownerId: string | null;
  /** The group's creator, or `null`. */
  createdById: string | null;
}

/** One member of a scope: a group's member with its role, or a personal library's owner as `admin`. */
export interface ScopeMember {
  userId: string;
  role: ScopeRole;
}

@Injectable()
export class OwnerScopeSweepService {
  constructor(
    private readonly groups: GroupsService,
    private readonly membership: GroupMembershipService,
    private readonly personal: PersonalLibraryStore,
    private readonly prisma: PrismaService,
    private readonly defaultOrgId: DefaultOrgId,
  ) {}

  /**
   * Every shared library (group), then every personal library, each once.
   *
   * @param reason - a registered system access reason naming the sweep.
   */
  async allScopes(reason: SharingSystemAccessReason = OWNER_SCOPE_SWEEP_REASON): Promise<ScopeSummary[]> {
    const byId = new Map<string, ScopeSummary>();

    let cursor: string | undefined;
    do {
      const page = await this.groups.listForSystem({ reason, cursor, limit: GROUP_PAGE_SIZE });
      for (const group of page.items) {
        byId.set(group.id, { id: group.id, name: group.name, kind: 'group', ownerId: null, createdById: group.createdById });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    let after: string | undefined;
    for (;;) {
      const rows = await this.personal.page(after, PERSONAL_PAGE_SIZE);
      for (const row of rows) {
        if (byId.has(row.id)) continue;
        byId.set(row.id, {
          id: row.id,
          name: personalLibraryName(row),
          kind: 'personal',
          ownerId: row.ownerId,
          createdById: null,
        });
      }
      if (rows.length < PERSONAL_PAGE_SIZE) break;
      after = rows[rows.length - 1]!.id;
    }

    return [...byId.values()];
  }

  /** The id of every shared library, then of every personal library. */
  async allScopeIds(reason: SharingSystemAccessReason = OWNER_SCOPE_SWEEP_REASON): Promise<string[]> {
    return (await this.allScopes(reason)).map((scope) => scope.id);
  }

  /**
   * One scope (name and kind), or `null` when no group or personal library has
   * this id. A group is found through the slice's `get` as a read-only
   * `groups:admin` principal (the same bypass the slice documents for an admin),
   * which needs no direct read of `groups`.
   */
  async summary(scopeId: string): Promise<ScopeSummary | null> {
    const personal = await this.personal.get(scopeId);
    if (personal) {
      return { id: personal.id, name: personalLibraryName(personal), kind: 'personal', ownerId: personal.ownerId, createdById: null };
    }
    try {
      const group = await this.groups.get(await this.adminPrincipal(), scopeId);
      return { id: group.id, name: group.name, kind: 'group', ownerId: null, createdById: group.createdById };
    } catch {
      return null;
    }
  }

  /**
   * Deletes a group (an empty one: content makes `owner_group_id` refuse) as a read-write
   * `groups:admin` principal. For the user removal hook only: the slice has no system delete.
   */
  async removeGroup(groupId: string): Promise<void> {
    await this.groups.delete(await this.adminPrincipal(), groupId);
  }

  private async adminPrincipal() {
    return {
      kind: 'user' as const,
      userId: SYSTEM_READER_ID,
      email: '',
      credential: 'session' as const,
      roles: [],
      permissions: [SHARING_PERMISSIONS.GROUPS_ADMIN],
      activeOrgId: await this.defaultOrgId.get(),
    };
  }

  /** Whether a group or a personal library has this id. */
  async exists(scopeId: string): Promise<boolean> {
    if ((await this.personal.ownerOf(scopeId)) !== null) return true;
    // A group always has an admin (LAST_GROUP_ADMIN), so one admin proves it exists.
    const admins = await this.membership.membersForSystem(scopeId, {
      reason: OWNER_SCOPE_MEMBERS_REASON,
      roles: ['admin'],
    });
    return admins.length > 0;
  }

  /**
   * The members of a scope, optionally only those with some roles. A personal
   * library has one member: its owner, as `admin`.
   */
  async membersOf(scopeId: string, roles?: readonly ScopeRole[]): Promise<ScopeMember[]> {
    const ownerId = await this.personal.ownerOf(scopeId);
    if (ownerId) {
      return !roles || roles.length === 0 || roles.includes('admin') ? [{ userId: ownerId, role: 'admin' }] : [];
    }
    const members = await this.membership.membersForSystem(scopeId, {
      reason: OWNER_SCOPE_MEMBERS_REASON,
      roles: roles && roles.length > 0 ? [...roles] : undefined,
    });
    return members.map((member) => ({ userId: member.userId, role: member.role as ScopeRole }));
  }

  /** Display fields of users, for owner names and member rows. */
  async userNames(userIds: readonly string[]): Promise<Map<string, { name: string | null; email: string }>> {
    const out = new Map<string, { name: string | null; email: string }>();
    if (userIds.length === 0) return out;
    const rows = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, email: true, displayName: true, providerDisplayName: true },
    });
    for (const row of rows) out.set(row.id, { name: row.displayName || row.providerDisplayName || null, email: row.email });
    return out;
  }
}

/** A principal id for system reads that act as no user (the slice only reads `userId` for membership). */
const SYSTEM_READER_ID = '00000000-0000-0000-0000-000000000000';
