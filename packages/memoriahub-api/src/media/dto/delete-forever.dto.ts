import { createZodDto } from 'nestjs-zod';
import { deleteForeverSchema } from '@marinoscar/memoriahub-contract/media';

export { deleteForeverSchema };

export class DeleteForeverDto extends createZodDto(deleteForeverSchema) {}
