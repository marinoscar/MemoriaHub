import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CircleRole } from '@prisma/client';
import { CircleMembershipService } from '../circle-membership.service';
import { CIRCLE_ROLE_KEY } from '../decorators/circle-role.decorator';
import { AuthenticatedUser, toRequestUser } from '../../auth/interfaces/authenticated-user.interface';

@Injectable()
export class CircleMemberGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly membershipService: CircleMembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRole = this.reflector.getAllAndOverride<CircleRole | undefined>(
      CIRCLE_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRole) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;
    const requestUser = toRequestUser(user);

    // Resolve circleId from request (params.id, params.circleId, query.circleId)
    const circleId: string =
      request.params?.id ||
      request.params?.circleId ||
      request.query?.circleId;

    if (!circleId) {
      throw new ForbiddenException('circleId is required');
    }

    await this.membershipService.assertCircleAccess(
      requestUser.id,
      circleId,
      requestUser.permissions,
      requiredRole,
    );

    return true;
  }
}
