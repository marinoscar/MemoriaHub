import { createZodDto } from 'nestjs-zod';
import { dashboardQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { dashboardQuerySchema };

/**
 * The `DashboardQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class DashboardQueryDto extends createZodDto(dashboardQuerySchema) {}
