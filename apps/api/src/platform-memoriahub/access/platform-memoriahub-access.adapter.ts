import { Injectable } from '@nestjs/common';
import { Trace } from '@marinoscar/platform-api/otel-core';
import { deleteGrantsForResources } from '@marinoscar/platform-api/sharing';
import type {
  MemoriahubAccessPort,
  MemoriahubOwnerAccess,
  MemoriahubRecordAction,
  MemoriahubRecordType,
  MemoriahubScopeMember,
  MemoriahubScopeRole,
  MemoriahubScopeSummary,
} from '@marinoscar/memoriahub-api/ports';

import { OwnerAccessService, hasOwnerBypass } from '../../platform/sharing/owner-scope';
import { OwnerScopeSweepService } from '../../platform/sharing/owner-scope-sweep.service';
import { RecordAccessService } from '../../platform/sharing/record-access';

// =============================================================================
// PlatformMemoriahubAccessAdapter: the `MEMORIAHUB_ACCESS` port over the sharing slice (RETRO-J4, #610)
// =============================================================================
//
// A THIN WRAPPER, not the platform types exposed. The decisions are the web app's own services, unchanged:
//
//   `OwnerAccessService`      the first check on every media and album route: roles in an owner scope
//                             (a shared library = a group, or a personal library), 404 for an unknown scope
//                             AND a non-member, 403 below the role, the bypass permissions
//   `RecordAccessService`     the second check, only when the first refused: user and group GRANTS on a
//                             `media_item` or `album` (`AccessPolicy.decide`, `accessibleWhere`)
//   `OwnerScopeSweepService`  every owner scope for a cron or a backfill (`groups.listForSystem`)
//
// so a member's outcome is exactly what it was before the port existed. A bare host binds a policy with
// no grants (`grantAllows` answers false, `sharedWhere` answers null) and keeps the same not-found rule.
// =============================================================================

@Injectable()
export class PlatformMemoriahubAccessAdapter implements MemoriahubAccessPort {
  constructor(
    private readonly owner: OwnerAccessService,
    private readonly records: RecordAccessService,
    private readonly sweep: OwnerScopeSweepService,
  ) {}

  @Trace()
  requireOwnerRole(
    userId: string,
    scopeId: string,
    permissions: readonly string[],
    minRole: MemoriahubScopeRole,
  ): Promise<MemoriahubOwnerAccess> {
    return this.owner.requireOwnerRole(userId, scopeId, permissions, minRole);
  }

  hasOwnerBypass(permissions: readonly string[] | undefined | null): boolean {
    return hasOwnerBypass(permissions);
  }

  @Trace()
  roleIn(userId: string, scopeId: string): Promise<MemoriahubScopeRole | null> {
    return this.owner.roleIn(userId, scopeId);
  }

  @Trace()
  rolesOf(userId: string): Promise<Array<{ scopeId: string; role: MemoriahubScopeRole; personal: boolean }>> {
    return this.owner.rolesOf(userId);
  }

  @Trace()
  scopesOf(userId: string): Promise<string[]> {
    return this.owner.scopesOf(userId);
  }

  @Trace()
  writableScopesOf(userId: string): Promise<string[]> {
    return this.owner.writableGroupsOf(userId);
  }

  @Trace()
  personalLibraryOf(userId: string): Promise<string | null> {
    return this.owner.personalLibraryOf(userId);
  }

  invalidateMembers(userIds: readonly string[]): void {
    this.owner.invalidateMembers(userIds);
  }

  @Trace()
  grantAllows(
    userId: string,
    permissions: readonly string[],
    action: MemoriahubRecordAction,
    type: MemoriahubRecordType,
    id: string,
  ): Promise<boolean> {
    return this.records.grantAllows(userId, permissions, action, type, id);
  }

  @Trace()
  grantsAllowAll(
    userId: string,
    permissions: readonly string[],
    action: MemoriahubRecordAction,
    type: MemoriahubRecordType,
    ids: readonly string[],
  ): Promise<boolean> {
    return this.records.grantsAllowAll(userId, permissions, action, type, ids);
  }

  @Trace()
  sharedWhere(
    userId: string,
    permissions: readonly string[],
    type: MemoriahubRecordType,
    minRole: 'viewer' | 'editor' = 'viewer',
  ): Promise<Record<string, unknown> | null> {
    return this.records.sharedWhere(userId, permissions, type, minRole);
  }

  deleteGrantsFor(tx: unknown, type: MemoriahubRecordType, ids: readonly string[]): Promise<number> {
    return deleteGrantsForResources(tx, type, ids);
  }

  @Trace()
  allScopes(): Promise<MemoriahubScopeSummary[]> {
    return this.sweep.allScopes();
  }

  @Trace()
  allScopeIds(): Promise<string[]> {
    return this.sweep.allScopeIds();
  }

  @Trace()
  scopeSummary(scopeId: string): Promise<MemoriahubScopeSummary | null> {
    return this.sweep.summary(scopeId);
  }

  @Trace()
  scopeExists(scopeId: string): Promise<boolean> {
    return this.sweep.exists(scopeId);
  }

  @Trace()
  membersOf(scopeId: string, roles?: readonly MemoriahubScopeRole[]): Promise<MemoriahubScopeMember[]> {
    return this.sweep.membersOf(scopeId, roles);
  }

  @Trace()
  userNames(userIds: readonly string[]): Promise<Map<string, { name: string | null; email: string }>> {
    return this.sweep.userNames(userIds);
  }
}
