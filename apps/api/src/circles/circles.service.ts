import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupInvitesService,
  GroupMembershipService,
  GroupsService,
  SHARING_PERMISSIONS,
} from '@marinoscar/platform-api/sharing';
import type { UserPrincipal } from '@marinoscar/platform-api/core';
import type { GroupDto, GroupInviteDto } from '@marinoscar/platform-contract/sharing';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { RequestUser } from '@marinoscar/platform-api/identity';

import { PrismaService } from '../prisma/prisma.service';
import { LEGACY_CIRCLE_ROLE_TO_OWNER_ROLE, OwnerAccessService } from '../platform/sharing/owner-scope';
import { OwnerScopeSweepService } from '../platform/sharing/owner-scope-sweep.service';
import { PersonalLibraryStore, personalLibraryName } from '../platform/sharing/personal-library.store';
import { DefaultOrgId } from '../common/tenancy/default-org-id';
import { MEMORIAHUB_EMAIL_EVENT_KEYS } from '../notifications-registry/memoriahub-email.notifications';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { GROUP_ROLE_TO_CIRCLE_ROLE, type CircleRoleName } from './circle-role';
import { GroupMemberMirrorListener } from './group-member-mirror.listener';
import { CreateCircleDto } from './dto/create-circle.dto';
import { UpdateCircleDto } from './dto/update-circle.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { CreateInviteDto } from './dto/create-invite.dto';

// =============================================================================
// `/api/circles/*` served from platform groups and personal libraries (RETRO-K1, #588)
// =============================================================================
//
// The routes and their JSON shapes are unchanged (the Android app still calls
// `GET /api/circles/:id`), but nothing here reads `circles` / `circle_members`
// any more: a shared circle is the platform group of the same id (`GroupsService`,
// `GroupMembershipService`), a personal circle is the caller's personal library
// (`PersonalLibraryStore`), and the circle role names are the group roles mapped
// back (`admin` -> `circle_admin`, `editor` -> `collaborator`).
// =============================================================================

/** Pages read for one list (100 each). */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** The circle shape the clients read. */
export interface CircleView {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  isPersonal: boolean;
  createdAt: string;
  updatedAt: string;
  _count: { members: number; mediaItems?: number };
  memberRole?: CircleRoleName;
}

@Injectable()
export class CirclesService {
  private readonly logger = new Logger(CirclesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: OwnerAccessService,
    private readonly notifications: NotificationsService,
    private readonly groupInvites: GroupInvitesService,
    private readonly defaultOrgId: DefaultOrgId,
    private readonly groups: GroupsService,
    private readonly groupMembers: GroupMembershipService,
    private readonly personal: PersonalLibraryStore,
    private readonly scopes: OwnerScopeSweepService,
    private readonly mirror: GroupMemberMirrorListener,
  ) {}

  /** Base URL for building absolute links in emails. */
  private appUrl(): string {
    return process.env['APP_URL'] || 'http://localhost:3535';
  }

  // ----- Circles -----

  async create(userId: string, dto: CreateCircleDto) {
    const principal = await this.principalOf({ id: userId, email: '', roles: [], permissions: [] });
    const group = await this.groups.create(principal, { name: dto.name, description: dto.description });
    // PLATFORM-ADOPTION-SHIM(RETRO-K1): until RETRO-K2 drops `circles`, every content row's `circle_id`
    // still has a foreign key to it, so the group's circle row is written here, before the response
    // (the group-created listener would do it asynchronously). K2 deletes this call.
    await this.mirror.ensureCircleFor(group.id, group.name, group.description, userId);
    this.membership.invalidateMembers([userId]);
    this.logger.log(`Circle created: ${group.id} by user ${userId}`);
    return this.groupView(group, 'admin');
  }

  async list(user: RequestUser, all: boolean) {
    const principal = await this.principalOf(user);
    if (all) {
      // `groups:admin` is the platform name of `circles:manage_any` (RETRO-I3).
      const isSuperAdmin =
        user.permissions.includes(SHARING_PERMISSIONS.GROUPS_ADMIN) ||
        user.permissions.includes(PERMISSIONS.CIRCLES_MANAGE_ANY);
      if (!isSuperAdmin) {
        throw new ForbiddenException('circles:manage_any permission required');
      }
      const items = [
        ...(await this.listGroups(principal, 'all')).map((g) => this.groupView(g, null)),
        ...(await this.allPersonalViews()),
      ].sort((a, b) => a.name.localeCompare(b.name));
      return { items, total: items.length, page: 1, pageSize: items.length, totalPages: 1 };
    }

    const items: CircleView[] = (await this.listGroups(principal, 'mine')).map((g) => this.groupView(g, g.myRole));
    const library = await this.personalView(user.id);
    if (library) items.push({ ...library, memberRole: 'circle_admin' });
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, total: items.length, page: 1, pageSize: items.length, totalPages: 1 };
  }

  async getById(user: RequestUser, id: string) {
    await this.membership.requireOwnerRole(user.id, id, user.permissions, 'viewer');
    const mediaItems = await this.prisma.mediaItem.count({ where: { circleId: id } });

    const library = await this.personalViewById(id);
    if (library) return { ...library, _count: { members: 1, mediaItems } };

    const group = await this.groups.get(await this.principalOf(user), id).catch(notFoundAs(`Circle ${id} not found`));
    const view = this.groupView(group, group.myRole);
    return { ...view, _count: { members: group.memberCount, mediaItems } };
  }

  async update(user: RequestUser, id: string, dto: UpdateCircleDto) {
    await this.membership.requireOwnerRole(user.id, id, user.permissions, 'admin');
    if ((await this.personal.ownerOf(id)) !== null) {
      throw new BadRequestException('A personal library cannot be renamed');
    }
    const group = await this.groups
      .update(await this.principalOf(user), id, {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
      })
      .catch(notFoundAs(`Circle ${id} not found`));
    return this.groupView(group, group.myRole);
  }

  async remove(user: RequestUser, id: string) {
    await this.membership.requireOwnerRole(user.id, id, user.permissions, 'admin');
    if ((await this.personal.ownerOf(id)) !== null) {
      throw new BadRequestException('Cannot delete a personal circle');
    }
    const summary = await this.scopes.summary(id);
    if (!summary) throw new NotFoundException(`Circle ${id} not found`);

    const members = await this.scopes.membersOf(id);
    // PLATFORM-ADOPTION-SHIM(RETRO-K1): deleting the circle row cascades the content (its foreign keys)
    // and the RETRO-I2 trigger deletes the mirrored group. RETRO-K2 deletes the group instead.
    await this.prisma.circle.delete({ where: { id } });
    this.membership.invalidateMembers(members.map((m) => m.userId));
    this.logger.log(`Circle ${id} deleted by user ${user.id}`);
  }

  // ----- Members -----

  async listMembers(user: RequestUser, circleId: string) {
    await this.membership.requireOwnerRole(user.id, circleId, user.permissions, 'viewer');

    const ownerId = await this.personal.ownerOf(circleId);
    if (ownerId) {
      const users = await this.userRows([ownerId]);
      const library = await this.personal.get(circleId);
      const items = [
        {
          id: `${circleId}:${ownerId}`,
          circleId,
          userId: ownerId,
          role: 'circle_admin' as CircleRoleName,
          createdAt: (library?.createdAt ?? new Date()).toISOString(),
          updatedAt: (library?.createdAt ?? new Date()).toISOString(),
          user: users.get(ownerId) ?? null,
        },
      ];
      return { items, total: items.length };
    }

    const principal = await this.principalOf(user);
    const rows: Awaited<ReturnType<GroupMembershipService['list']>>['items'] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await this.groupMembers
        .list(principal, circleId, { page, pageSize: PAGE_SIZE })
        .catch(notFoundAs(`Circle ${circleId} not found`));
      rows.push(...list.items);
      if (page >= list.totalPages) break;
    }
    const users = await this.userRows(rows.map((m) => m.userId));
    // The former list was oldest first.
    const items = rows
      .map((m) => this.memberView(circleId, m, users.get(m.userId) ?? null))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { items, total: items.length };
  }

  async addMember(user: RequestUser, circleId: string, dto: AddMemberDto) {
    await this.membership.requireOwnerRole(user.id, circleId, user.permissions, 'admin');

    // Verify target user exists
    const targetUser = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!targetUser) throw new NotFoundException(`User ${dto.userId} not found`);
    await this.assertNotPersonal(circleId);

    const member = await this.groupMembers.add(await this.principalOf(user), circleId, {
      userId: dto.userId,
      role: LEGACY_CIRCLE_ROLE_TO_OWNER_ROLE[dto.role],
    });
    this.membership.invalidateMembers([dto.userId]);

    const users = await this.userRows([dto.userId]);
    const row = users.get(dto.userId) ?? null;
    // Membership-confirmation email (best-effort, fire-and-forget).
    if (row?.email) {
      await this.sendMembershipEmail(circleId, row.email, dto.role);
    }
    return this.memberView(circleId, member, row);
  }

  /**
   * Best-effort membership-confirmation email. Never blocks or fails the request.
   */
  private async sendMembershipEmail(
    circleId: string,
    recipientEmail: string,
    role: string,
  ): Promise<void> {
    try {
      const circle = await this.scopes.summary(circleId);
      if (!circle) return;
      const description = circle.kind === 'group' ? await this.groupDescription(circleId) : null;

      // Detached and after the membership write committed (RETRO-D3): the event's
      // only channel is email, bound to the `membership-confirmation` template.
      void this.notifications.notifyAddress(MEMORIAHUB_EMAIL_EVENT_KEYS.membershipConfirmed, recipientEmail, {
        circleName: circle.name,
        circleDescription: description ?? undefined,
        role,
        viewUrl: `${this.appUrl()}/circles/${circleId}`,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue membership-confirmation email: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async updateMemberRole(
    user: RequestUser,
    circleId: string,
    targetUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    await this.membership.requireOwnerRole(user.id, circleId, user.permissions, 'admin');
    await this.assertNotPersonal(circleId);

    const updated = await this.groupMembers
      .changeRole(await this.principalOf(user), circleId, targetUserId, LEGACY_CIRCLE_ROLE_TO_OWNER_ROLE[dto.role])
      .catch(lastAdminAs('Cannot demote the last circle admin', `User ${targetUserId} is not a member of circle ${circleId}`));
    this.membership.invalidateMembers([targetUserId]);
    const users = await this.userRows([targetUserId]);
    return this.memberView(circleId, updated, users.get(targetUserId) ?? null);
  }

  async removeMember(user: RequestUser, circleId: string, targetUserId: string) {
    const isSelf = user.id === targetUserId;

    if (!isSelf) {
      await this.membership.requireOwnerRole(user.id, circleId, user.permissions, 'admin');
    } else {
      // Self-leave: must at least be a member (viewer-level)
      await this.membership.requireOwnerRole(user.id, circleId, user.permissions, 'viewer');
    }
    await this.assertNotPersonal(circleId);

    await this.groupMembers
      .remove(await this.principalOf(user), circleId, targetUserId)
      .catch(lastAdminAs('Cannot remove the last circle admin', `User ${targetUserId} is not a member of circle ${circleId}`));
    this.membership.invalidateMembers([targetUserId]);
  }

  /**
   * A personal library has no group (RETRO-I2, circles-to-groups.md §2): its
   * rows belong to its owner alone, and a member added to it would hold no
   * access since RETRO-I3 decides access on groups. Refuse instead of adding
   * a member who can see nothing.
   */
  private async assertNotPersonal(circleId: string): Promise<void> {
    if ((await this.personal.ownerOf(circleId)) !== null) {
      throw new BadRequestException('A personal circle cannot have other members');
    }
  }

  // ----- Shapes -----

  private groupView(group: GroupDto, role: string | null): CircleView {
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      ownerId: group.createdById ?? '',
      isPersonal: false,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      _count: { members: group.memberCount },
      ...(role ? { memberRole: GROUP_ROLE_TO_CIRCLE_ROLE[role] ?? 'viewer' } : {}),
    };
  }

  private memberView(
    circleId: string,
    member: { groupId?: string; userId: string; role: string; createdAt: string },
    user: UserRow | null,
  ) {
    return {
      id: `${circleId}:${member.userId}`,
      circleId,
      userId: member.userId,
      role: GROUP_ROLE_TO_CIRCLE_ROLE[member.role] ?? 'viewer',
      createdAt: member.createdAt,
      updatedAt: member.createdAt,
      user,
    };
  }

  private async personalViewById(scopeId: string): Promise<CircleView | null> {
    const library = await this.personal.get(scopeId);
    return library ? this.libraryView(library) : null;
  }

  private async personalView(userId: string): Promise<CircleView | null> {
    const id = await this.personal.idOf(userId);
    return id ? this.personalViewById(id) : null;
  }

  private libraryView(library: Awaited<ReturnType<PersonalLibraryStore['get']>> & object): CircleView {
    return {
      id: library.id,
      name: personalLibraryName(library),
      description: null,
      ownerId: library.ownerId,
      isPersonal: true,
      createdAt: library.createdAt.toISOString(),
      updatedAt: library.createdAt.toISOString(),
      _count: { members: 1 },
    };
  }

  private async allPersonalViews(): Promise<CircleView[]> {
    const out: CircleView[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.personal.page(after, 500);
      out.push(...page.map((library) => this.libraryView(library)));
      if (page.length < 500) break;
      after = page[page.length - 1]!.id;
    }
    return out;
  }

  private async listGroups(principal: UserPrincipal, scope: 'mine' | 'all'): Promise<GroupDto[]> {
    const out: GroupDto[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await this.groups.list(principal, { scope, page, pageSize: PAGE_SIZE });
      out.push(...list.items);
      if (page >= list.totalPages) break;
    }
    return out;
  }

  private async groupDescription(groupId: string): Promise<string | null> {
    const group = await this.groups.get(await this.principalOf({ id: SYSTEM_READER_ID, email: '', roles: [], permissions: [SHARING_PERMISSIONS.GROUPS_ADMIN] }), groupId).catch(() => null);
    return group?.description ?? null;
  }

  private async userRows(userIds: readonly string[]): Promise<Map<string, UserRow>> {
    const out = new Map<string, UserRow>();
    if (userIds.length === 0) return out;
    const rows = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: {
        id: true,
        email: true,
        displayName: true,
        providerDisplayName: true,
        profileImageUrl: true,
        providerProfileImageUrl: true,
      },
    });
    for (const row of rows) out.set(row.id, row);
    return out;
  }

  // ----- Invites -----
  //
  // RETRO-I5 (#583): a circle invite IS a platform group invite (a shared
  // circle's id is its group's id). These three methods keep the
  // `/api/circles/:id/invites` routes and their legacy body shape for the web
  // (until RETRO-I6 moves the page onto the sharing slice's own
  // `/api/groups/:id/invites`), and delegate every read and write to
  // `GroupInvitesService`: the slice checks the caller is the group's admin,
  // stores the invite, audits it and sends `groups.invitation`; the notifier
  // allowlists the invitee (`SharingNotifierAdapter`, through `IDENTITY_ALLOWLIST`).
  // Behaviour that changed with the move: a second invite to an address with a
  // pending one is 409 `INVITE_PENDING` (it used to update the pending invite's
  // role: revoke and re-invite instead), an address that is already a member is
  // 409 `ALREADY_A_MEMBER`, revoking an answered invite is 409
  // `INVITE_NOT_PENDING` (was 400), and `notes` is no longer stored.

  async listInvites(user: RequestUser, circleId: string) {
    await this.membership.requireOwnerRole(user.id, circleId, user.permissions, 'admin');
    if (await this.isPersonal(circleId)) return { items: [], total: 0 };
    const principal = await this.principalOf(user);
    const items: LegacyCircleInvite[] = [];
    for (let page = 1; page <= INVITE_LIST_MAX_PAGES; page++) {
      const list = await this.groupInvites.list(principal, circleId, {
        status: 'all',
        page,
        pageSize: INVITE_LIST_PAGE_SIZE,
      });
      for (const invite of list.items) {
        // The former list held pending and claimed invites only: a revoked one was deleted.
        if (invite.status === 'pending' || invite.status === 'accepted') items.push(toLegacyInvite(invite));
      }
      if (page >= list.totalPages) break;
    }
    return { items, total: items.length };
  }

  async createInvite(user: RequestUser, circleId: string, dto: CreateInviteDto) {
    await this.membership.requireOwnerRole(user.id, circleId, user.permissions, 'admin');
    await this.assertNotPersonal(circleId);
    const invite = await this.groupInvites.create(await this.principalOf(user), circleId, {
      email: dto.email,
      role: LEGACY_CIRCLE_ROLE_TO_OWNER_ROLE[dto.role],
    });
    return toLegacyInvite(invite);
  }

  async revokeInvite(user: RequestUser, circleId: string, inviteId: string) {
    await this.membership.requireOwnerRole(user.id, circleId, user.permissions, 'admin');
    if (await this.isPersonal(circleId)) throw new NotFoundException(`Invite ${inviteId} not found`);
    await this.groupInvites.revoke(await this.principalOf(user), circleId, inviteId);
    this.logger.log(`Invite ${inviteId} revoked by user ${user.id}`);
  }

  private async isPersonal(circleId: string): Promise<boolean> {
    return (await this.personal.ownerOf(circleId)) !== null;
  }

  /**
   * The caller as the sharing slice sees it. MemoriaHub is single organization,
   * so the active organization is the default one; `circles:manage_any` is the
   * deprecated name of `groups:admin` (the slice's bypass), kept one release.
   */
  private async principalOf(user: Pick<RequestUser, 'id' | 'email' | 'roles' | 'permissions'> & { activeOrgId?: string | null }): Promise<UserPrincipal> {
    const permissions = user.permissions.includes(PERMISSIONS.CIRCLES_MANAGE_ANY)
      ? [...user.permissions, SHARING_PERMISSIONS.GROUPS_ADMIN]
      : user.permissions;
    return {
      kind: 'user',
      userId: user.id,
      email: user.email,
      credential: 'session',
      roles: user.roles,
      permissions,
      activeOrgId: user.activeOrgId ?? (await this.defaultOrgId.get()),
    };
  }
}

type UserRow = {
  id: string;
  email: string;
  displayName: string | null;
  providerDisplayName: string | null;
  profileImageUrl: string | null;
  providerProfileImageUrl: string | null;
};

const SYSTEM_READER_ID = '00000000-0000-0000-0000-000000000000';

/** Maps the slice's "group not found" onto the circle routes' 404 body. */
function notFoundAs(message: string): (err: unknown) => never {
  return (err) => {
    if (err instanceof NotFoundException) throw new NotFoundException(message);
    throw err;
  };
}

/** The slice's `LAST_GROUP_ADMIN` 409 is the former 400; a missing member stays 404. */
function lastAdminAs(lastAdminMessage: string, notMemberMessage: string): (err: unknown) => never {
  return (err) => {
    if (err instanceof ConflictException) {
      const body = err.getResponse() as { code?: string } | string;
      const code = typeof body === 'object' ? body.code : undefined;
      if (code === 'LAST_GROUP_ADMIN') throw new BadRequestException(lastAdminMessage);
    }
    if (err instanceof NotFoundException) throw new NotFoundException(notMemberMessage);
    throw err;
  };
}

/** Pages read for one invite list (100 each): a circle with more than 1000 invites lists the newest 1000. */
const INVITE_LIST_PAGE_SIZE = 100;
const INVITE_LIST_MAX_PAGES = 10;

/** The former `circle_invites` row shape the web reads (`apps/web/src/types/circles.ts`). */
export interface LegacyCircleInvite {
  id: string;
  circleId: string;
  email: string;
  role: CircleRoleName;
  notes: null;
  addedById: string | null;
  addedAt: string;
  claimedById: null;
  claimedAt: string | null;
}

export function toLegacyInvite(invite: GroupInviteDto): LegacyCircleInvite {
  return {
    id: invite.id,
    circleId: invite.groupId,
    email: invite.email,
    role: GROUP_ROLE_TO_CIRCLE_ROLE[invite.role] ?? 'viewer',
    notes: null,
    addedById: invite.invitedById,
    addedAt: invite.createdAt,
    claimedById: null,
    claimedAt: invite.acceptedAt,
  };
}
