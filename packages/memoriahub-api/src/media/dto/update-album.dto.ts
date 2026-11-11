import { createZodDto } from 'nestjs-zod';
import { updateAlbumSchema } from '@marinoscar/memoriahub-contract/media';

export { updateAlbumSchema };

export class UpdateAlbumDto extends createZodDto(updateAlbumSchema) {}
