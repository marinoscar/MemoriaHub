// =============================================================================
// Record access: grants on `media_item` and `album` (RETRO-I3, #573)
// =============================================================================
//
// `OwnerAccessService` decides a caller's access to an OWNER SCOPE (a shared
// circle = a group, or a personal library) and is the first, unchanged check
// on every media and album route. This service is the second check, run ONLY
// when the first one refused: it asks the sharing slice's `AccessPolicy`
// whether a GRANT (user or group grant, `/api/grants`) lets the caller do the
// action on the record anyway.
//
// Why two steps and not `AccessPolicy.require` alone:
//
//   * members keep exactly today's access. The owner-scope rules carry bypass
//     permissions (`groups:admin`, `circles:manage_any`, `media:read_any`,
//     `media:write_any` on every action) and role requirements (some writes
//     need the group `admin` role) that the resource type's `actions` /
//     `bypassPermissions` do not express one-to-one. Running the owner check
//     first and consulting the policy only on a refusal guarantees no member's
//     outcome changes;
//   * a grant can only ADD access: the fallback accepts a decision only when
//     the policy allowed it THROUGH A GRANT (`via` `user_grant` /
//     `group_grant`), so the policy's own owner / bypass paths, already decided
//     by the first check, can never widen anything.
//
// Group-`admin`-only actions (emptying the trash, clustering, ...) never fall
// back: a grant names a record, not an owner scope.
//
// Lists: a member's list keeps its `circle_id` filter and its index plan
// (gallery keyset `media_items_gallery_idx`, map, KNN) untouched. A caller who
// is NOT a member but holds grants gets the same list AND-ed with
// `accessibleWhere(..., { scope: 'shared' })` (an inline id list from ONE
// bounded grant query; above 1,000 grants the EXISTS form, resolved here to an
// id list); a caller with no grants keeps the 404.
// =============================================================================

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { UserPrincipal } from '@marinoscar/platform-api/core';
import {
  AccessPolicy,
  PrincipalGroupsProvider,
  SHARING_DATA,
  accessibleWhere,
  resourceKey,
  type AccessDecision,
  type SharingDataPort,
} from '@marinoscar/platform-api/sharing';
import { Prisma } from '@prisma/client';

import { DefaultOrgId } from '../../common/tenancy/default-org-id';
import type { OwnerRole } from './owner-scope';

/** The two shareable resource types (registered in `app-registrations/sharing.ts`). */
export type RecordType = 'media_item' | 'album';

/** The policy actions a grant can satisfy (`delete`, `share` need the owner). */
export type RecordAction = 'read' | 'write' | 'delete';

/** What allowed a decision when the fallback admitted it. */
const GRANT_VIA = new Set(['user_grant', 'group_grant']);

/** The upper bound of a shared-id list resolved from the EXISTS form. */
export const SHARED_IDS_MAX = 10_000;

/** The action a former owner-scope role maps to; `admin` has none (never granted). */
export function actionForRole(minRole: OwnerRole): RecordAction | null {
  if (minRole === 'viewer') return 'read';
  if (minRole === 'editor') return 'write';
  return null;
}

/** A refusal the grant fallback may override: the owner check's 404 (non-member) or 403 (role too low). */
export function isAccessRefusal(err: unknown): boolean {
  return err instanceof NotFoundException || err instanceof ForbiddenException;
}

/** Whether a decision was allowed through a grant. */
export function allowedByGrant(decision: AccessDecision | undefined): boolean {
  return !!decision && decision.allowed && decision.via !== null && GRANT_VIA.has(decision.via);
}

/** The Prisma table name of each type, for the EXISTS form. */
const TABLE: Readonly<Record<RecordType, string>> = { media_item: 'media_items', album: 'albums' };

@Injectable()
export class RecordAccessService {
  constructor(
    private readonly policy: AccessPolicy,
    private readonly principalGroups: PrincipalGroupsProvider,
    @Inject(SHARING_DATA) private readonly data: SharingDataPort,
    private readonly defaultOrgId: DefaultOrgId,
  ) {}

  /**
   * Whether a grant lets the caller do `action` on one record. ONE
   * `AccessPolicy.decide`; `false` for anything but a grant.
   */
  async grantAllows(userId: string, permissions: readonly string[], action: RecordAction, type: RecordType, id: string): Promise<boolean> {
    const decision = await this.policy.decide(await this.principalFor(userId, permissions), action, { type, id });
    return allowedByGrant(decision);
  }

  /**
   * Whether grants let the caller do `action` on EVERY record of a batch:
   * ONE `AccessPolicy.decideMany` for the whole batch (never one call per id).
   */
  async grantsAllowAll(
    userId: string,
    permissions: readonly string[],
    action: RecordAction,
    type: RecordType,
    ids: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return false;
    const refs = unique.map((id) => ({ type, id }));
    const decisions = await this.policy.decideMany(await this.principalFor(userId, permissions), action, refs);
    return refs.every((ref) => allowedByGrant(decisions.get(resourceKey(ref))));
  }

  /**
   * The Prisma `where` fragment of the records of `type` shared with the caller
   * through a grant (`accessibleWhere`, scope `shared`), or `null` when nothing
   * is shared with them. AND it with the list's own filters, never spread it.
   */
  async sharedWhere(
    userId: string,
    permissions: readonly string[],
    type: RecordType,
    minRole: 'viewer' | 'editor' = 'viewer',
  ): Promise<Record<string, unknown> | null> {
    const principal = await this.principalGroups.enrich(await this.principalFor(userId, permissions));
    const orgId = principal.activeOrgId as string;
    // The slice's own way in (`SharingDataAdapter.runInOrg`): transaction-local org scope.
    return this.data.runInOrg({ orgId, userId }, async (rawTx: unknown) => {
      const tx = rawTx as Prisma.TransactionClient;
      const access = await accessibleWhere(principal, type, { tx, sqlKit: Prisma, scope: 'shared', minRole });
      if (access.form === 'where') return isNothing(access.where) ? null : access.where;
      // More than 1,000 shared records: resolve the EXISTS form to a bounded id list.
      const rows = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT r.id::text AS id FROM ${Prisma.raw(TABLE[type])} r WHERE ${access.sql as Prisma.Sql} LIMIT ${SHARED_IDS_MAX}`,
      );
      return rows.length === 0 ? null : { id: { in: rows.map((row) => row.id) } };
    }) as Promise<Record<string, unknown> | null>;
  }

  /**
   * The principal the policy decides for: the caller's permissions, in the
   * default organization (single-organization mode, as `OwnerAccessService`).
   * PLATFORM-ADOPTION-SHIM(RETRO-MULTI-ORG): multi-organization mode needs the
   * request's principal here.
   */
  async principalFor(userId: string, permissions: readonly string[]): Promise<UserPrincipal> {
    return {
      kind: 'user',
      userId,
      email: '',
      credential: 'session',
      roles: [],
      permissions: [...permissions],
      activeOrgId: await this.defaultOrgId.get(),
    };
  }
}

/** `accessibleWhere`'s empty result: `{ id: { in: [] } }`. */
function isNothing(where: Record<string, unknown>): boolean {
  const keys = Object.keys(where);
  if (keys.length !== 1) return false;
  const value = where[keys[0]] as { in?: unknown } | undefined;
  return !!value && typeof value === 'object' && Array.isArray(value.in) && value.in.length === 0 && Object.keys(value).length === 1;
}
