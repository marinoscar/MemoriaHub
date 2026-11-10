import { createZodDto } from 'nestjs-zod';
import { duplicateQuerySchema } from '@marinoscar/memoriahub-contract/dedup';

export { duplicateQuerySchema };

export class DuplicateQueryDto extends createZodDto(duplicateQuerySchema) {}
