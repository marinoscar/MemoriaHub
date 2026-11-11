import { createZodDto } from 'nestjs-zod';
import { sharedWithMeQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { sharedWithMeQuerySchema };

export class SharedWithMeQueryDto extends createZodDto(sharedWithMeQuerySchema) {}
