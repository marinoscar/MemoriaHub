import { createZodDto } from 'nestjs-zod';
import { bulkResolveBurstThresholdSchema } from '@marinoscar/memoriahub-contract/burst';

export { bulkResolveBurstThresholdSchema };

export class BulkResolveBurstThresholdDto extends createZodDto(bulkResolveBurstThresholdSchema) {}
