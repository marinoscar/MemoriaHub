import { createZodDto } from 'nestjs-zod';
import { bulkResolveDuplicateSchema } from '@marinoscar/memoriahub-contract/dedup';

export { bulkResolveDuplicateSchema };

export class BulkResolveDuplicateDto extends createZodDto(bulkResolveDuplicateSchema) {}
