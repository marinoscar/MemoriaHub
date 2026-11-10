import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type {
  MemoriahubAccessPort,
  MemoriahubOwnerAccess,
  MemoriahubRecordAction,
  MemoriahubRecordType,
  MemoriahubScopeMember,
  MemoriahubScopeRole,
  MemoriahubScopeSummary,
} from '../ports/index.js';

const RANK: Readonly<Record<MemoriahubScopeRole, number>> = { viewer: 1, editor: 2, admin: 3 };

/**
 * The permission the fake treats as an owner-scope bypass.
 *
 * @stability experimental
 */
export const FAKE_BYPASS_PERMISSION = 'groups:admin';

/** One grant the fake knows: a user may do an action on a record. */
interface FakeGrant {
  userId: string;
  type: MemoriahubRecordType;
  id: string;
  actions: readonly MemoriahubRecordAction[];
}

/**
 * An in-memory `MEMORIAHUB_ACCESS`: shared scopes with members and roles, personal libraries, and record
 * grants. A non-member of a scope gets the same `NotFoundException` as for an unknown scope, a member
 * below the role a `ForbiddenException`.
 *
 * @stability experimental
 */
export class FakeMemoriahubAccess implements MemoriahubAccessPort {
  private readonly scopes = new Map<string, MemoriahubScopeSummary>();

  private readonly members = new Map<string, Map<string, MemoriahubScopeRole>>();

  private readonly grants: FakeGrant[] = [];

  /** User ids passed to `invalidateMembers`, in order. */
  readonly invalidated: string[] = [];

  /**
   * Adds a shared library.
   *
   * @param id - the scope id.
   * @param name - its name.
   * @param members - the members and their roles.
   */
  addGroup(id: string, name: string, members: Record<string, MemoriahubScopeRole>): void {
    this.scopes.set(id, { id, name, kind: 'group', ownerId: null, createdById: null });
    this.members.set(id, new Map(Object.entries(members)));
  }

  /**
   * Adds a personal library.
   *
   * @param id - the scope id.
   * @param ownerId - the owner.
   */
  addPersonalLibrary(id: string, ownerId: string): void {
    this.scopes.set(id, { id, name: `${ownerId}'s Library`, kind: 'personal', ownerId, createdById: null });
    this.members.set(id, new Map([[ownerId, 'admin']]));
  }

  /**
   * Grants a user actions on one record.
   *
   * @param userId - the grantee.
   * @param type - the record type.
   * @param id - the record id.
   * @param actions - what is allowed.
   */
  grant(userId: string, type: MemoriahubRecordType, id: string, actions: readonly MemoriahubRecordAction[]): void {
    this.grants.push({ userId, type, id, actions });
  }

  /** Bypass check. */
  hasOwnerBypass(permissions: readonly string[] | undefined | null): boolean {
    return !!permissions && permissions.includes(FAKE_BYPASS_PERMISSION);
  }

  /** Role check, 404 for non-members and unknown scopes, 403 below the role. */
  async requireOwnerRole(
    userId: string,
    scopeId: string,
    permissions: readonly string[],
    minRole: MemoriahubScopeRole,
  ): Promise<MemoriahubOwnerAccess> {
    if (this.hasOwnerBypass(permissions)) return { role: await this.roleIn(userId, scopeId), isSuperAdmin: true };
    const role = await this.roleIn(userId, scopeId);
    if (role === null) throw new NotFoundException(`Circle ${scopeId} not found`);
    if (RANK[role] < RANK[minRole]) throw new ForbiddenException(`This action requires ${minRole} role or higher`);
    return { role, isSuperAdmin: false };
  }

  /** The caller's role. */
  async roleIn(userId: string, scopeId: string): Promise<MemoriahubScopeRole | null> {
    return this.members.get(scopeId)?.get(userId) ?? null;
  }

  /** Roles across scopes. */
  async rolesOf(userId: string): Promise<Array<{ scopeId: string; role: MemoriahubScopeRole; personal: boolean }>> {
    const out: Array<{ scopeId: string; role: MemoriahubScopeRole; personal: boolean }> = [];
    for (const [scopeId, members] of this.members) {
      const role = members.get(userId);
      if (role) out.push({ scopeId, role, personal: this.scopes.get(scopeId)?.kind === 'personal' });
    }
    return out.sort((a, b) => Number(b.personal) - Number(a.personal) || a.scopeId.localeCompare(b.scopeId));
  }

  /** Scope ids, personal first. */
  async scopesOf(userId: string): Promise<string[]> {
    return (await this.rolesOf(userId)).map((r) => r.scopeId);
  }

  /** Writable group scopes. */
  async writableScopesOf(userId: string): Promise<string[]> {
    return (await this.rolesOf(userId))
      .filter((r) => !r.personal && (r.role === 'editor' || r.role === 'admin'))
      .map((r) => r.scopeId)
      .sort();
  }

  /** Personal library id. */
  async personalLibraryOf(userId: string): Promise<string | null> {
    for (const scope of this.scopes.values()) if (scope.kind === 'personal' && scope.ownerId === userId) return scope.id;
    return null;
  }

  /** Records the users whose membership changed. */
  invalidateMembers(userIds: readonly string[]): void {
    this.invalidated.push(...userIds);
  }

  /** One-record grant check. */
  async grantAllows(
    userId: string,
    _permissions: readonly string[],
    action: MemoriahubRecordAction,
    type: MemoriahubRecordType,
    id: string,
  ): Promise<boolean> {
    return this.grants.some((g) => g.userId === userId && g.type === type && g.id === id && g.actions.includes(action));
  }

  /** Batch grant check. */
  async grantsAllowAll(
    userId: string,
    permissions: readonly string[],
    action: MemoriahubRecordAction,
    type: MemoriahubRecordType,
    ids: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return false;
    for (const id of unique) if (!(await this.grantAllows(userId, permissions, action, type, id))) return false;
    return true;
  }

  /** The shared-with-me where fragment. */
  async sharedWhere(
    userId: string,
    _permissions: readonly string[],
    type: MemoriahubRecordType,
    minRole: 'viewer' | 'editor' = 'viewer',
  ): Promise<Record<string, unknown> | null> {
    const wanted: MemoriahubRecordAction = minRole === 'editor' ? 'write' : 'read';
    const ids = this.grants.filter((g) => g.userId === userId && g.type === type && g.actions.includes(wanted)).map((g) => g.id);
    return ids.length === 0 ? null : { id: { in: ids } };
  }

  /** Removes grants of records. */
  async deleteGrantsFor(_tx: unknown, type: MemoriahubRecordType, ids: readonly string[]): Promise<number> {
    const before = this.grants.length;
    for (let i = this.grants.length - 1; i >= 0; i -= 1) {
      const g = this.grants[i]!;
      if (g.type === type && ids.includes(g.id)) this.grants.splice(i, 1);
    }
    return before - this.grants.length;
  }

  /** Every scope. */
  async allScopes(): Promise<MemoriahubScopeSummary[]> {
    return [...this.scopes.values()];
  }

  /** Every scope id. */
  async allScopeIds(): Promise<string[]> {
    return [...this.scopes.keys()];
  }

  /** One scope. */
  async scopeSummary(scopeId: string): Promise<MemoriahubScopeSummary | null> {
    return this.scopes.get(scopeId) ?? null;
  }

  /** Whether a scope exists. */
  async scopeExists(scopeId: string): Promise<boolean> {
    return this.scopes.has(scopeId);
  }

  /** Members of a scope. */
  async membersOf(scopeId: string, roles?: readonly MemoriahubScopeRole[]): Promise<MemoriahubScopeMember[]> {
    const members = this.members.get(scopeId);
    if (!members) return [];
    return [...members.entries()]
      .map(([userId, role]) => ({ userId, role }))
      .filter((m) => !roles || roles.length === 0 || roles.includes(m.role));
  }

  /** Display names. */
  async userNames(userIds: readonly string[]): Promise<Map<string, { name: string | null; email: string }>> {
    return new Map(userIds.map((id) => [id, { name: id, email: `${id}@example.test` }]));
  }
}
