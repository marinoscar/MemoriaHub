import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const attachTagsSchema = z.object({
  names: z
    .array(z.string().min(1).max(128))
    .min(1, 'At least one tag name is required'),
});

export class AttachTagsDto extends createZodDto(attachTagsSchema) {}
