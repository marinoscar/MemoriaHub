import { createZodDto } from 'nestjs-zod';
import { emptyTrashSchema } from '@marinoscar/memoriahub-contract/media';

export { emptyTrashSchema };

export class EmptyTrashDto extends createZodDto(emptyTrashSchema) {}
