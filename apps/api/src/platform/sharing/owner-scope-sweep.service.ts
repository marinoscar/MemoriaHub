import { Injectable } from '@nestjs/common';
import { GroupsService, type SharingSystemAccessReason } from '@marinoscar/platform-api/sharing';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// Every owner scope, for an admin sweep (RETRO-N29, #1137)
// =============================================================================
//
// The admin backfills and the location rebuild walk "every circle": every
// shared library plus one personal library per user (an owner scope id, see
// `docs/platform-adoption/circles-to-groups.md` §8). The shared libraries are
// platform groups now, listed through `GroupsService.listForSystem` under the
// registered `OWNER_SCOPE_SWEEP_REASON` (no organization: every organization,
// on the system client). A personal library is not a group: those ids still come
// from the app's `circles` table (`is_personal`), kept equal to the owner
// columns by the RETRO-I2 triggers. The union is returned in a stable order.
// =============================================================================

/** The slice's page size ceiling for `listForSystem` (`SYSTEM_GROUPS_MAX_LIMIT`). */
const GROUP_PAGE_SIZE = 500;
const PERSONAL_PAGE_SIZE = 500;

@Injectable()
export class OwnerScopeSweepService {
  constructor(
    private readonly groups: GroupsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The id of every shared library (group), then of every personal library.
   * Each id appears once.
   *
   * @param reason - a registered system access reason naming the sweep.
   */
  async allScopeIds(reason: SharingSystemAccessReason): Promise<string[]> {
    const ids = new Set<string>();

    let cursor: string | undefined;
    do {
      const page = await this.groups.listForSystem({ reason, cursor, limit: GROUP_PAGE_SIZE });
      for (const group of page.items) ids.add(group.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    let after: string | undefined;
    for (;;) {
      const personal = await this.prisma.circle.findMany({
        where: { isPersonal: true },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PERSONAL_PAGE_SIZE,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      });
      for (const circle of personal) ids.add(circle.id);
      if (personal.length < PERSONAL_PAGE_SIZE) break;
      after = personal[personal.length - 1]!.id;
    }

    return [...ids];
  }
}
