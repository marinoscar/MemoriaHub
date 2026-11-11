import { createZodDto } from 'nestjs-zod';
import { bulkTagsSchema } from '@marinoscar/memoriahub-contract/media';

export { bulkTagsSchema };

export class BulkTagsDto extends createZodDto(bulkTagsSchema) {}
