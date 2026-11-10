import { createZodDto } from 'nestjs-zod';
import { bulkResolveBurstSchema } from '@marinoscar/memoriahub-contract/burst';

export { bulkResolveBurstSchema };

export class BulkResolveBurstDto extends createZodDto(bulkResolveBurstSchema) {}
