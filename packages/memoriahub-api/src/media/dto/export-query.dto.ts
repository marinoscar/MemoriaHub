import { createZodDto } from 'nestjs-zod';
import { exportQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { exportQuerySchema };

/**
 * The `ExportQueryDto` request shape, built from its contract schema.
 *
 * @stability experimental
 */
export class ExportQueryDto extends createZodDto(exportQuerySchema) {}
