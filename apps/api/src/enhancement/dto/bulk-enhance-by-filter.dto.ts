import { createZodDto } from 'nestjs-zod';
import { bulkEnhanceByFilterSchema, type BulkEnhanceByFilter } from '@marinoscar/memoriahub-contract/enhancement';

export { bulkEnhanceByFilterSchema };
export type { BulkEnhanceByFilter };

export class BulkEnhanceByFilterDto extends createZodDto(bulkEnhanceByFilterSchema) {}
