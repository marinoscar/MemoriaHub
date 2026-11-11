import { createZodDto } from 'nestjs-zod';
import { dashboardQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { dashboardQuerySchema };

export class DashboardQueryDto extends createZodDto(dashboardQuerySchema) {}
