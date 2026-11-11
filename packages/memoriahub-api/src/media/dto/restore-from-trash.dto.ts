import { createZodDto } from 'nestjs-zod';
import { restoreFromTrashSchema } from '@marinoscar/memoriahub-contract/media';

export { restoreFromTrashSchema };

export class RestoreFromTrashDto extends createZodDto(restoreFromTrashSchema) {}
