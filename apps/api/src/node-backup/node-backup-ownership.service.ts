// =============================================================================
// Node ownership for the Local Media Backup routes (RETRO-C2, #581)
// =============================================================================
//
// `/api/nodes/:id/backup/*` resolves the node by id AND the caller: another user's node, and a node
// that does not exist, both answer 404 (never 403, so a node id cannot be probed). The platform's
// own ownership check (`NodeOwnershipService`, `@NodeRoute()`) answers 403 for another user's
// node; these app routes keep the 404 the Local Media Backup contract has always had, so they use
// this check and not `@NodeRoute()`.
// =============================================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import type { WorkerNode } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NodeBackupOwnershipService {
  constructor(private readonly prisma: PrismaService) {}

  /** The node `nodeId` when `userId` registered it; 404 otherwise. */
  async assertOwnership(userId: string, nodeId: string): Promise<WorkerNode> {
    const node = await this.prisma.workerNode.findFirst({ where: { id: nodeId, createdById: userId } });
    if (!node) {
      throw new NotFoundException(`Worker node ${nodeId} was not found`);
    }
    return node;
  }
}
