import { createZodDto } from 'nestjs-zod';
import { createTrashEmptyRunSchema } from '@marinoscar/memoriahub-contract/media';

export { createTrashEmptyRunSchema };

export class CreateTrashEmptyRunDto extends createZodDto(createTrashEmptyRunSchema) {}
