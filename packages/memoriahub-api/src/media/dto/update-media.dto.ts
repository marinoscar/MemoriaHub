import { createZodDto } from 'nestjs-zod';
import { updateMediaSchema } from '@marinoscar/memoriahub-contract/media';

export { updateMediaSchema };

export class UpdateMediaDto extends createZodDto(updateMediaSchema) {}
