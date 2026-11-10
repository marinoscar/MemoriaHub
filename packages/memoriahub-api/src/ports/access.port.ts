// =============================================================================
// MEMORIAHUB_ACCESS: the access port (RETRO-J4, #610)
// =============================================================================
//
// THE ONLY WAY A SLICE DECIDES WHO MAY TOUCH A RECORD. Two layers, as the web
// edition runs them today (RETRO-I3, K1):
//
//   1. OWNER SCOPES. Every media item and album belongs to an owner scope: a shared
//      library (a group) or a personal library. `requireOwnerRole` is the first,
//      unchanged check on every route: 404 for an unknown scope AND for a non-member
//      (one message, so ids cannot be probed), 403 for a member below the role.
//   2. RECORD GRANTS. When layer 1 refused, a user or group GRANT on one record can
//      still allow `read`, `write` or `delete` (`grantAllows`, `grantsAllowAll`,
//      `sharedWhere`). A grant can only ADD access; group-admin-only actions never
//      fall back to it.
//
// A thin wrapper over the platform sharing API, so a bare host can bind a simple
// owner-only policy (`grantAllows` answers false, `sharedWhere` answers null).
//
// NOT-FOUND IS NOT FORBIDDEN. A non-member of a scope never learns the scope exists:
// the refusal is a `NotFoundException`. The conformance kit asserts it.
// =============================================================================

/**
 * Injection token of {@link MemoriahubAccessPort}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_ACCESS = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_ACCESS');

/**
 * A role inside an owner scope. `admin` is also what a personal library's owner holds.
 *
 * @stability experimental
 */
export type MemoriahubScopeRole = 'viewer' | 'editor' | 'admin';

/**
 * The result of a passed owner-scope check.
 *
 * @stability experimental
 */
export interface MemoriahubOwnerAccess {
  /** The caller's role in the scope, or `null` for a bypassing non-member. */
  role: MemoriahubScopeRole | null;
  /** True when the caller passed through a bypass permission (a system administrator). */
  isSuperAdmin: boolean;
}

/**
 * The shareable record types.
 *
 * @stability experimental
 */
export type MemoriahubRecordType = 'media_item' | 'album';

/**
 * The actions a record grant can satisfy (`delete` and `share` need the owner scope).
 *
 * @stability experimental
 */
export type MemoriahubRecordAction = 'read' | 'write' | 'delete';

/**
 * One owner scope as a sweep sees it.
 *
 * @stability experimental
 */
export interface MemoriahubScopeSummary {
  /** The scope id: a group id, or a personal library's id. */
  id: string;
  /** Display name (a group's name, or "<owner>'s Library"). */
  name: string;
  /** Whether it is a shared library or a personal one. */
  kind: 'group' | 'personal';
  /** The owning user of a personal library; `null` for a group. */
  ownerId: string | null;
  /** The group's creator, or `null`. */
  createdById: string | null;
}

/**
 * One member of a scope.
 *
 * @stability experimental
 */
export interface MemoriahubScopeMember {
  /** The member's user id. */
  userId: string;
  /** The member's role. */
  role: MemoriahubScopeRole;
}

/**
 * The access port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubAccessPort {
  /**
   * Refuses unless the caller holds at least `minRole` in the scope (or a bypass permission).
   *
   * @param userId - the caller.
   * @param scopeId - the owner scope (a group id or a personal library id).
   * @param permissions - the caller's permission strings (the bypass permissions are among them for a system administrator).
   * @param minRole - the lowest role that may do the action.
   * @returns the caller's role and whether a bypass admitted them.
   * @throws NotFoundException for an unknown scope and for a non-member; ForbiddenException for a member below `minRole`.
   */
  requireOwnerRole(
    userId: string,
    scopeId: string,
    permissions: readonly string[],
    minRole: MemoriahubScopeRole,
  ): Promise<MemoriahubOwnerAccess>;

  /**
   * Whether the permissions carry an owner-scope bypass (a system administrator's).
   *
   * @param permissions - the caller's permission strings.
   */
  hasOwnerBypass(permissions: readonly string[] | undefined | null): boolean;

  /**
   * The caller's role in a scope, or `null` when the scope is unknown or the caller holds none.
   *
   * @param userId - the caller.
   * @param scopeId - the owner scope.
   */
  roleIn(userId: string, scopeId: string): Promise<MemoriahubScopeRole | null>;

  /**
   * The user's role in each scope they belong to: their personal library as `admin`, then each group.
   *
   * @param userId - the user.
   */
  rolesOf(userId: string): Promise<Array<{ scopeId: string; role: MemoriahubScopeRole; personal: boolean }>>;

  /**
   * Every scope id the user belongs to: their personal library first, then each group (any role).
   *
   * @param userId - the user.
   */
  scopesOf(userId: string): Promise<string[]>;

  /**
   * The scope ids the user can write in (role `editor` or `admin`), groups only, sorted.
   *
   * @param userId - the user.
   */
  writableScopesOf(userId: string): Promise<string[]>;

  /**
   * The user's personal library id, or `null` when they have none.
   *
   * @param userId - the user.
   */
  personalLibraryOf(userId: string): Promise<string | null>;

  /**
   * Drops cached memberships of `userIds`. Call it after a membership write commits, outside any
   * transaction. Never throws.
   *
   * @param userIds - the users whose membership changed.
   */
  invalidateMembers(userIds: readonly string[]): void;

  /**
   * Whether a GRANT lets the caller do `action` on one record. False for anything but a grant.
   *
   * @param userId - the caller.
   * @param permissions - the caller's permission strings.
   * @param action - the action.
   * @param type - the record type.
   * @param id - the record id.
   */
  grantAllows(
    userId: string,
    permissions: readonly string[],
    action: MemoriahubRecordAction,
    type: MemoriahubRecordType,
    id: string,
  ): Promise<boolean>;

  /**
   * Whether grants let the caller do `action` on EVERY record of a batch: one decision for the
   * whole batch, never one call per id. False for an empty batch.
   *
   * @param userId - the caller.
   * @param permissions - the caller's permission strings.
   * @param action - the action.
   * @param type - the record type.
   * @param ids - the record ids.
   */
  grantsAllowAll(
    userId: string,
    permissions: readonly string[],
    action: MemoriahubRecordAction,
    type: MemoriahubRecordType,
    ids: readonly string[],
  ): Promise<boolean>;

  /**
   * The Prisma `where` fragment of the records of `type` shared with the caller through a grant, or
   * `null` when nothing is shared with them. AND it with the list's own filters, never spread it.
   *
   * @param userId - the caller.
   * @param permissions - the caller's permission strings.
   * @param type - the record type.
   * @param minRole - `viewer` for reads, `editor` for writes.
   */
  sharedWhere(
    userId: string,
    permissions: readonly string[],
    type: MemoriahubRecordType,
    minRole?: 'viewer' | 'editor',
  ): Promise<Record<string, unknown> | null>;

  /**
   * Deletes the grants on records, inside the caller's delete transaction.
   *
   * @param tx - the transaction client of the open transaction.
   * @param type - the record type.
   * @param ids - the record ids being deleted.
   * @returns how many grants were removed.
   */
  deleteGrantsFor(tx: unknown, type: MemoriahubRecordType, ids: readonly string[]): Promise<number>;

  /**
   * Every owner scope (the sweep of a cron or a backfill), shared libraries and personal ones.
   */
  allScopes(): Promise<MemoriahubScopeSummary[]>;

  /**
   * Every owner scope id.
   */
  allScopeIds(): Promise<string[]>;

  /**
   * One scope's summary, or `null` for an unknown id.
   *
   * @param scopeId - the owner scope.
   */
  scopeSummary(scopeId: string): Promise<MemoriahubScopeSummary | null>;

  /**
   * Whether a scope exists.
   *
   * @param scopeId - the owner scope.
   */
  scopeExists(scopeId: string): Promise<boolean>;

  /**
   * The members of a scope: a group's members with their roles, or a personal library's owner as `admin`.
   *
   * @param scopeId - the owner scope.
   * @param roles - keep only these roles; all when absent or empty.
   */
  membersOf(scopeId: string, roles?: readonly MemoriahubScopeRole[]): Promise<MemoriahubScopeMember[]>;

  /**
   * Display fields of users, for owner names and member rows.
   *
   * @param userIds - the users.
   */
  userNames(userIds: readonly string[]): Promise<Map<string, { name: string | null; email: string }>>;
}
