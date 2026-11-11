import { createZodDto } from 'nestjs-zod';
import { bulkArchiveSchema } from '@marinoscar/memoriahub-contract/media';

export { bulkArchiveSchema };

export class BulkArchiveDto extends createZodDto(bulkArchiveSchema) {}
