import { createZodDto } from 'nestjs-zod';
import { bulkEnhanceSchema, type BulkEnhance } from '@marinoscar/memoriahub-contract/enhancement';

export { bulkEnhanceSchema };
export type { BulkEnhance };

export class BulkEnhanceDto extends createZodDto(bulkEnhanceSchema) {}
