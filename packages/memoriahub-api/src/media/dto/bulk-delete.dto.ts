import { createZodDto } from 'nestjs-zod';
import { bulkDeleteSchema } from '@marinoscar/memoriahub-contract/media';

export { bulkDeleteSchema };

export class BulkDeleteDto extends createZodDto(bulkDeleteSchema) {}
