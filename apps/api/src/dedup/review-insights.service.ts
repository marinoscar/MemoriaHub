import { Injectable } from '@nestjs/common';
import { CircleRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';

/** Per-domain review stats returned for both bursts and duplicates. */
interface ReviewDomainStats {
  identified: number;
  pending: number;
  resolved: number;
  dismissed: number;
  archivedGroups: number;
  trashedGroups: number;
  itemsKept: number;
  itemsArchived: number;
  itemsDeleted: number;
}

/** Loosely-typed shape of a `groupBy(['status'])` result row. */
interface StatusGroupRow {
  status: string;
  _count: { _all: number };
}

/** Loosely-typed shape of a `groupBy(['resolutionAction'])` result row. */
interface ActionGroupRow {
  resolutionAction: string | null;
  _count: { _all: number };
  _sum: { keptCount: number | null; removedCount: number | null };
}

@Injectable()
export class ReviewInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: CircleMembershipService,
  ) {}

  async getReviewInsights(circleId: string, userId: string, perms: string[]) {
    await this.membership.assertCircleAccess(userId, circleId, perms, CircleRole.viewer);

    const [
      burstStatusGroups,
      burstActionGroups,
      dupStatusGroups,
      dupActionGroups,
    ] = await Promise.all([
      this.prisma.burstGroup.groupBy({
        by: ['status'],
        where: { circleId },
        _count: { _all: true },
      }),
      this.prisma.burstGroup.groupBy({
        by: ['resolutionAction'],
        where: { circleId, status: 'resolved' },
        _count: { _all: true },
        _sum: { keptCount: true, removedCount: true },
      }),
      this.prisma.duplicateGroup.groupBy({
        by: ['status'],
        where: { circleId },
        _count: { _all: true },
      }),
      this.prisma.duplicateGroup.groupBy({
        by: ['resolutionAction'],
        where: { circleId, status: 'resolved' },
        _count: { _all: true },
        _sum: { keptCount: true, removedCount: true },
      }),
    ]);

    return {
      bursts: this.aggregate(
        burstStatusGroups as StatusGroupRow[],
        burstActionGroups as ActionGroupRow[],
      ),
      duplicates: this.aggregate(
        dupStatusGroups as StatusGroupRow[],
        dupActionGroups as ActionGroupRow[],
      ),
    };
  }

  private aggregate(
    statusGroups: StatusGroupRow[],
    actionGroups: ActionGroupRow[],
  ): ReviewDomainStats {
    let identified = 0;
    let pending = 0;
    let resolved = 0;
    let dismissed = 0;

    for (const row of statusGroups) {
      const count = row._count?._all ?? 0;
      identified += count;
      if (row.status === 'pending') pending = count;
      else if (row.status === 'resolved') resolved = count;
      else if (row.status === 'dismissed') dismissed = count;
    }

    let archivedGroups = 0;
    let trashedGroups = 0;
    let itemsKept = 0;
    let itemsArchived = 0;
    let itemsDeleted = 0;

    for (const row of actionGroups) {
      const count = row._count?._all ?? 0;
      const kept = row._sum?.keptCount ?? 0;
      const removed = row._sum?.removedCount ?? 0;
      itemsKept += kept;
      if (row.resolutionAction === 'archive') {
        archivedGroups = count;
        itemsArchived = removed;
      } else if (row.resolutionAction === 'trash') {
        trashedGroups = count;
        itemsDeleted = removed;
      }
    }

    return {
      identified,
      pending,
      resolved,
      dismissed,
      archivedGroups,
      trashedGroups,
      itemsKept,
      itemsArchived,
      itemsDeleted,
    };
  }
}
