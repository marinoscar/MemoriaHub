import { SetMetadata } from '@nestjs/common';
import { CircleRole } from '@prisma/client';

export const CIRCLE_ROLE_KEY = 'circle_role';
export const RequireCircleRole = (role: CircleRole) => SetMetadata(CIRCLE_ROLE_KEY, role);
