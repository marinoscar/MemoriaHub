import { createZodDto } from 'nestjs-zod';
import { attachTagsSchema } from '@marinoscar/memoriahub-contract/media';

export { attachTagsSchema };

export class AttachTagsDto extends createZodDto(attachTagsSchema) {}
