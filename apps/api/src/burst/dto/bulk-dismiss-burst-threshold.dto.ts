import { createZodDto } from 'nestjs-zod';
import { bulkDismissBurstThresholdSchema } from '@marinoscar/memoriahub-contract/burst';

export { bulkDismissBurstThresholdSchema };

export class BulkDismissBurstThresholdDto extends createZodDto(bulkDismissBurstThresholdSchema) {}
