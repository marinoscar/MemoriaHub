import { createZodDto } from 'nestjs-zod';
import { bulkDismissDuplicateThresholdSchema } from '@marinoscar/memoriahub-contract/dedup';

export { bulkDismissDuplicateThresholdSchema };

export class BulkDismissDuplicateThresholdDto extends createZodDto(bulkDismissDuplicateThresholdSchema) {}
