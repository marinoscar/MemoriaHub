import { Injectable } from '@nestjs/common';
import { Trace } from '@marinoscar/platform-api/otel-core';
import { LinkGrantsService } from '@marinoscar/platform-api/sharing';
import type {
  MemoriahubExpiringLinkPage,
  MemoriahubExpiringLinkQuery,
  MemoriahubSharingPort,
} from '@marinoscar/memoriahub-api/ports';

import { DefaultOrgId } from '../../common/tenancy/default-org-id';

// =============================================================================
// PlatformMemoriahubSharingAdapter: the `MEMORIAHUB_SHARING` port over the platform sharing slice
// (RETRO-J10, #624)
// =============================================================================
//
// A public link is a platform LINK GRANT (`grants`, `grantee_kind = 'link'`, since RETRO-I4 #578). The
// expiring ones are `LinkGrantsService.listExpiring` (the sharing slice's expiring-link sweep seam; the
// platform clock decides "now"; links that never expire, are revoked or already expired are not listed),
// keyset-paged by the grant id.
//
// PLATFORM-ADOPTION-SHIM(RETRO-MULTI-ORG): the single (default) organization, as everywhere MemoriaHub
// reads link grants without a caller (`public-links`).
// =============================================================================

@Injectable()
export class PlatformMemoriahubSharingAdapter implements MemoriahubSharingPort {
  constructor(
    private readonly links: LinkGrantsService,
    private readonly defaultOrg: DefaultOrgId,
  ) {}

  @Trace()
  async listExpiringLinks(query: MemoriahubExpiringLinkQuery): Promise<MemoriahubExpiringLinkPage> {
    const orgId = await this.defaultOrg.get();
    const page = await this.links.listExpiring({ orgId, within: query.within, cursor: query.cursor, limit: query.limit });
    return {
      items: page.items.map((grant) => ({
        id: grant.grantId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        grantedById: grant.grantedById,
        expiresAt: grant.expiresAt,
      })),
      nextCursor: page.nextCursor,
    };
  }
}
