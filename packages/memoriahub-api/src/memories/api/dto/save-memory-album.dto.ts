import { createZodDto } from 'nestjs-zod';
import { saveMemoryAlbumSchema } from '@marinoscar/memoriahub-contract/memories';

export { saveMemoryAlbumSchema };

/** SaveMemoryAlbumDto: save memory album dto. @stability experimental */
export class SaveMemoryAlbumDto extends createZodDto(saveMemoryAlbumSchema) {}
