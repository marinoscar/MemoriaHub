// =============================================================================
// Organization-wide reads of link grants (RETRO-I4, #578)
// PLATFORM-ADOPTION-SHIM(#578): seam request "a cross-record link listing"
// =============================================================================
//
// The sharing slice lists a record's links (`GET /api/grants/links?resourceType&
// resourceId`, `LinkGrantsService.list`) but has no listing ACROSS records. Two
// MemoriaHub features need one, and both existed over `media_shares`:
//
//   - the `share_expiring` notification sweep: every active link whose expiry
//     falls in the next seven days, whoever created it;
//   - the admin page `/admin/settings/sharing` (`sharing:admin`): every public
//     link of the organization, filterable by status and type, so an
//     administrator can find and revoke a leaked one.
//
// This is the ONE app file that reads the `grants` table directly (the sharing
// conformance suite's `no-direct-access` exempts it, with this reason). It is
// READ-ONLY and LINK-ONLY (`grantee_kind = 'link'`): every write (create, re-date,
// revoke) goes through the slice's routes (`POST /api/grants/links`, `PATCH` /
// `DELETE /api/grants/:id`), so audit rows, events and the policy stay the
// slice's. It runs in the default organization's scope (`runInOrg`, row-level
// security applies; single-organization mode, PLATFORM-ADOPTION-SHIM(RETRO-MULTI-ORG)).
// It never selects the token hash or ciphertext except to hand a row to the
// slice's own `toLinkGrantView`, which re-derives the shareable URL.
//
// Retire when the slice ships an organization-wide link listing (the seam
// request in docs/platform-adoption/local-exceptions.md).
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { toLinkGrantView } from '@marinoscar/platform-api/sharing';

import { DefaultOrgId } from '../common/tenancy/default-org-id';
import { PrismaService } from '../prisma/prisma.service';

/** The two resource types a MemoriaHub link can open. */
export type LinkResourceType = 'media_item' | 'album';

/** A link's state, derived from `revoked_at` and `expires_at`. */
export type LinkStatus = 'active' | 'expired' | 'revoked';

/** One link expiring soon: what the `share_expiring` sweep needs. */
export interface ExpiringLink {
  id: string;
  resourceType: string;
  resourceId: string;
  grantedById: string | null;
  expiresAt: Date;
}

/** One link as the admin page lists it. */
export interface AdminLinkRow {
  id: string;
  resourceType: string;
  resourceId: string;
  role: string;
  label: string | null;
  /** `<APP_URL>/s#lnk_...`, re-derived by the slice; `null` when it cannot be. */
  url: string | null;
  status: LinkStatus;
  expiresAt: string | null;
  revokedAt: string | null;
  grantedById: string | null;
  createdAt: string;
}

export interface AdminLinkQuery {
  status?: LinkStatus;
  resourceType?: LinkResourceType;
  page: number;
  pageSize: number;
}

/** `appUrl` for the re-derived link URL: the same default as `links.appUrl`. */
export function linkAppUrl(): string {
  return process.env.APP_URL || 'http://localhost:3535';
}

/** `active` / `expired` / `revoked` of one link at `now`. */
export function linkStatusOf(row: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): LinkStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt <= now) return 'expired';
  return 'active';
}

/** The `where` of a status filter, at `now`. */
export function linkStatusWhere(status: LinkStatus | undefined, now: Date): Prisma.GrantWhereInput {
  if (status === 'revoked') return { revokedAt: { not: null } };
  if (status === 'expired') return { revokedAt: null, expiresAt: { lte: now } };
  if (status === 'active') return { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  return {};
}

const LINK_TYPES: readonly LinkResourceType[] = ['media_item', 'album'];

@Injectable()
export class LinkGrantDirectory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly defaultOrg: DefaultOrgId,
  ) {}

  /**
   * One keyset page (by id) of active links expiring in `(now, horizon]`.
   * Revoked links and links that never expire are excluded by the query.
   */
  async expiringPage(now: Date, horizon: Date, take: number, afterId?: string): Promise<ExpiringLink[]> {
    const orgId = await this.defaultOrg.get();
    const rows = await this.prisma.runInOrg(orgId, (tx) =>
      tx.grant.findMany({
        where: {
          granteeKind: 'link',
          resourceType: { in: [...LINK_TYPES] },
          revokedAt: null,
          expiresAt: { gt: now, lte: horizon },
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        orderBy: { id: 'asc' },
        take,
        select: { id: true, resourceType: true, resourceId: true, grantedById: true, expiresAt: true },
      }),
    );
    return rows.flatMap((row) => (row.expiresAt ? [{ ...row, expiresAt: row.expiresAt }] : []));
  }

  /** A page of every link of the organization, newest first. */
  async adminPage(query: AdminLinkQuery, now: Date = new Date()): Promise<{ items: AdminLinkRow[]; total: number }> {
    const orgId = await this.defaultOrg.get();
    const where: Prisma.GrantWhereInput = {
      granteeKind: 'link',
      resourceType: query.resourceType ? query.resourceType : { in: [...LINK_TYPES] },
      ...linkStatusWhere(query.status, now),
    };
    const { rows, total } = await this.prisma.runInOrg(orgId, async (tx) => {
      const [count, page] = await Promise.all([
        tx.grant.count({ where }),
        tx.grant.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);
      return { rows: page, total: count };
    });
    const appUrl = linkAppUrl();
    const items = rows.map((row): AdminLinkRow => {
      const view = toLinkGrantView(row, appUrl);
      return {
        id: view.id,
        resourceType: view.resourceType,
        resourceId: view.resourceId,
        role: view.role,
        label: view.label,
        url: view.url,
        status: linkStatusOf(row, now),
        expiresAt: view.expiresAt,
        revokedAt: view.revokedAt,
        grantedById: view.grantedById,
        createdAt: view.createdAt,
      };
    });
    return { items, total };
  }
}
