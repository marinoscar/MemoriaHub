import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const dashboardQuerySchema = z.object({
  circleId: z.string().uuid(),
});

export class DashboardQueryDto extends createZodDto(dashboardQuerySchema) {}
