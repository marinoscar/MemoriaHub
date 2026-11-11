import { createZodDto } from 'nestjs-zod';
import { exportQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { exportQuerySchema };

export class ExportQueryDto extends createZodDto(exportQuerySchema) {}
