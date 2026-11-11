import { createZodDto } from 'nestjs-zod';
import { createMediaSchema } from '@marinoscar/memoriahub-contract/media';

export { createMediaSchema };

export class CreateMediaDto extends createZodDto(createMediaSchema) {}
