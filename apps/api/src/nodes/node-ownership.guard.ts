// =============================================================================
// Node Ownership Guard
// =============================================================================
//
// Optional route guard that asserts the authenticated caller owns the worker
// node referenced by the `:id` route param. The authoritative enforcement for
// the data-plane lives in NodesService.assertOwnership (called on every
// owner-scoped method); this guard is provided for reuse should a route want to
// short-circuit before hitting the service.
// =============================================================================

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

interface FastifyRequestWithUser {
  user?: RequestUser;
  requestUser?: RequestUser;
  params?: Record<string, string>;
}

@Injectable()
export class NodeOwnershipGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequestWithUser>();
    const user = request.requestUser || request.user;
    const nodeId = request.params?.id;

    if (!user || !nodeId) {
      throw new ForbiddenException('Missing authenticated user or node id');
    }

    const node = await this.prisma.workerNode.findUnique({
      where: { id: nodeId },
      select: { createdById: true },
    });

    if (!node) {
      throw new NotFoundException(`WorkerNode ${nodeId} not found`);
    }
    if (node.createdById !== user.id) {
      throw new ForbiddenException('You do not own this worker node');
    }

    return true;
  }
}
