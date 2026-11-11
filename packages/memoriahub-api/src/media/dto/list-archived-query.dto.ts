import { createZodDto } from 'nestjs-zod';
import { listArchivedQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { listArchivedQuerySchema };

export class ListArchivedQueryDto extends createZodDto(listArchivedQuerySchema) {}
