import { createZodDto } from 'nestjs-zod';
import { albumQuerySchema } from '@marinoscar/memoriahub-contract/media';

export { albumQuerySchema };

export class AlbumQueryDto extends createZodDto(albumQuerySchema) {}
