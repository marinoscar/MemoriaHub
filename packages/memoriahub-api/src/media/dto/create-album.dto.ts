import { createZodDto } from 'nestjs-zod';
import { createAlbumSchema } from '@marinoscar/memoriahub-contract/media';

export { createAlbumSchema };

export class CreateAlbumDto extends createZodDto(createAlbumSchema) {}
