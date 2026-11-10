import { createZodDto } from 'nestjs-zod';
import { saveMemoryAlbumSchema } from '@marinoscar/memoriahub-contract/memories';

export { saveMemoryAlbumSchema };

export class SaveMemoryAlbumDto extends createZodDto(saveMemoryAlbumSchema) {}
