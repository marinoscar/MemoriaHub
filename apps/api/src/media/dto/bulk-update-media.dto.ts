import { createZodDto } from 'nestjs-zod';
import { bulkUpdateMediaSchema } from '@marinoscar/memoriahub-contract/media';

export { bulkUpdateMediaSchema };

export class BulkUpdateMediaDto extends createZodDto(bulkUpdateMediaSchema) {}
