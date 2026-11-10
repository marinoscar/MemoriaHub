import { createZodDto } from 'nestjs-zod';
import { bulkResolveDuplicateThresholdSchema } from '@marinoscar/memoriahub-contract/dedup';

export { bulkResolveDuplicateThresholdSchema };

export class BulkResolveDuplicateThresholdDto extends createZodDto(bulkResolveDuplicateThresholdSchema) {}
